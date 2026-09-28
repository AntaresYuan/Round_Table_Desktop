#include "isolation-canary-input.h"

#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RT_PROCARGS_BUFFER_BYTES (1024U * 1024U)
#define RT_LAUNCHCTL_OUTPUT_BYTES 4096U
#define RT_LAUNCHCTL_WAIT_ITERATIONS 200U
#define RT_LAUNCHCTL_WAIT_NANOSECONDS 10000000L
#define RT_RESTRICTED_WORKER_FLAG "--roundtable-null-bootstrap-worker"

extern char **environ;

typedef enum {
    RT_CANARY_OUTCOME_DENIED = 0,
    RT_CANARY_OUTCOME_ALLOWED = 1,
    RT_CANARY_OUTCOME_INCONCLUSIVE = 2,
    RT_CANARY_OUTCOME_SUCCEEDED = 3,
    RT_CANARY_OUTCOME_FAILED = 4,
} rt_canary_outcome_t;

typedef struct {
    rt_canary_outcome_t outcome;
    int code;
} rt_canary_result_t;

static bool rt_permission_denied(int error) {
    return error == EPERM || error == EACCES;
}

static const char *rt_outcome_name(rt_canary_outcome_t outcome) {
    switch (outcome) {
        case RT_CANARY_OUTCOME_DENIED:
            return "denied";
        case RT_CANARY_OUTCOME_ALLOWED:
            return "allowed";
        case RT_CANARY_OUTCOME_INCONCLUSIVE:
            return "inconclusive";
        case RT_CANARY_OUTCOME_SUCCEEDED:
            return "succeeded";
        case RT_CANARY_OUTCOME_FAILED:
            return "failed";
    }
    return "inconclusive";
}

static rt_canary_result_t rt_result_from_denial_attempt(
    int call_result,
    int error
) {
    if (call_result == 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_ALLOWED,
            .code = 0,
        };
    }
    return (rt_canary_result_t){
        .outcome = rt_permission_denied(error)
            ? RT_CANARY_OUTCOME_DENIED
            : RT_CANARY_OUTCOME_INCONCLUSIVE,
        .code = error,
    };
}

static bool rt_host_identity_matches(
    pid_t host_pid,
    uid_t expected_host_uid
) {
    int management_information_base[4] = {
        CTL_KERN,
        KERN_PROC,
        KERN_PROC_PID,
        host_pid,
    };
    struct kinfo_proc process_information = {0};
    size_t process_information_size = sizeof(process_information);
    if (sysctl(
            management_information_base,
            4U,
            &process_information,
            &process_information_size,
            NULL,
            0U
        ) != 0 || process_information_size != sizeof(process_information)) {
        return false;
    }
    return process_information.kp_eproc.e_ucred.cr_uid == expected_host_uid;
}

static rt_canary_result_t rt_probe_host_procargs(pid_t host_pid) {
    int management_information_base[3] = {
        CTL_KERN,
        KERN_PROCARGS2,
        host_pid,
    };
    unsigned char *buffer = calloc(RT_PROCARGS_BUFFER_BYTES, 1U);
    if (buffer == NULL) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = ENOMEM,
        };
    }
    size_t buffer_size = RT_PROCARGS_BUFFER_BYTES;
    errno = 0;
    const int result = sysctl(
        management_information_base,
        3U,
        buffer,
        &buffer_size,
        NULL,
        0U
    );
    const int saved_error = errno;
    memset(buffer, 0, RT_PROCARGS_BUFFER_BYTES);
    free(buffer);
    if (result == 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_ALLOWED,
            .code = 0,
        };
    }
    /* macOS reports EINVAL, rather than EPERM, for some cross-UID targets. */
    return (rt_canary_result_t){
        .outcome = rt_permission_denied(saved_error) || saved_error == EINVAL
            ? RT_CANARY_OUTCOME_DENIED
            : RT_CANARY_OUTCOME_INCONCLUSIVE,
        .code = saved_error,
    };
}

static rt_canary_result_t rt_probe_host_signal(pid_t host_pid) {
    errno = 0;
    const int result = kill(host_pid, SIGUSR1);
    return rt_result_from_denial_attempt(result, errno);
}

static bool rt_contains_launchd_denial(
    const char *output,
    size_t output_length,
    int exit_code
) {
    if (output_length == 0U) {
        return false;
    }

    char bounded[RT_LAUNCHCTL_OUTPUT_BYTES + 1U];
    const size_t copy_length = output_length > RT_LAUNCHCTL_OUTPUT_BYTES
        ? RT_LAUNCHCTL_OUTPUT_BYTES
        : output_length;
    memcpy(bounded, output, copy_length);
    bounded[copy_length] = '\0';
    return strstr(bounded, "Operation not permitted") != NULL ||
        strstr(bounded, "Permission denied") != NULL ||
        strstr(bounded, "Not privileged") != NULL ||
        (exit_code == 141 && strstr(bounded, "Reentrancy avoided") != NULL);
}

static void rt_capture_available_output(
    int descriptor,
    char *output,
    size_t output_capacity,
    size_t *output_length
) {
    char scratch[512];
    for (;;) {
        const ssize_t count = read(descriptor, scratch, sizeof(scratch));
        if (count > 0) {
            const size_t available = *output_length < output_capacity
                ? output_capacity - *output_length
                : 0U;
            const size_t observed = (size_t)count;
            const size_t copy_length = observed < available
                ? observed
                : available;
            if (copy_length > 0U) {
                memcpy(output + *output_length, scratch, copy_length);
                *output_length += copy_length;
            }
            continue;
        }
        if (count < 0 && errno == EINTR) {
            continue;
        }
        return;
    }
}

static int rt_wait_for_child(
    pid_t child,
    int output_descriptor,
    char *output,
    size_t output_capacity,
    size_t *output_length,
    int *status
) {
    const struct timespec delay = {
        .tv_sec = 0,
        .tv_nsec = RT_LAUNCHCTL_WAIT_NANOSECONDS,
    };

    for (size_t attempt = 0U; attempt < RT_LAUNCHCTL_WAIT_ITERATIONS;
         attempt += 1U) {
        rt_capture_available_output(
            output_descriptor,
            output,
            output_capacity,
            output_length
        );
        const pid_t waited = waitpid(child, status, WNOHANG);
        if (waited == child) {
            rt_capture_available_output(
                output_descriptor,
                output,
                output_capacity,
                output_length
            );
            return 0;
        }
        if (waited < 0 && errno != EINTR) {
            return errno;
        }
        (void)nanosleep(&delay, NULL);
    }

    (void)kill(child, SIGKILL);
    while (waitpid(child, status, 0) < 0) {
        if (errno != EINTR) {
            break;
        }
    }
    rt_capture_available_output(
        output_descriptor,
        output,
        output_capacity,
        output_length
    );
    return ETIMEDOUT;
}

static rt_canary_result_t rt_probe_launchd_control(
    uid_t host_uid,
    const char *launchd_label
) {
    char service_target[RT_ISOLATION_CANARY_MAX_LABEL_BYTES + 64U];
    const int target_length = snprintf(
        service_target,
        sizeof(service_target),
        "gui/%llu/%s",
        (unsigned long long)host_uid,
        launchd_label
    );
    if (target_length <= 0 || (size_t)target_length >= sizeof(service_target)) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = EINVAL,
        };
    }

    int output_pipe[2];
    if (pipe(output_pipe) != 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = errno,
        };
    }
    (void)fcntl(output_pipe[0], F_SETFD, FD_CLOEXEC);
    (void)fcntl(output_pipe[1], F_SETFD, FD_CLOEXEC);
    const int current_flags = fcntl(output_pipe[0], F_GETFL, 0);
    if (current_flags < 0 ||
        fcntl(output_pipe[0], F_SETFL, current_flags | O_NONBLOCK) != 0) {
        const int saved_error = errno;
        (void)close(output_pipe[0]);
        (void)close(output_pipe[1]);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = saved_error,
        };
    }

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    int spawn_error = posix_spawn_file_actions_init(&actions);
    if (spawn_error == 0) {
        spawn_error = posix_spawnattr_init(&attributes);
        if (spawn_error != 0) {
            (void)posix_spawn_file_actions_destroy(&actions);
        }
    }
    if (spawn_error != 0) {
        (void)close(output_pipe[0]);
        (void)close(output_pipe[1]);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = spawn_error,
        };
    }

    spawn_error = posix_spawn_file_actions_addopen(
        &actions,
        STDIN_FILENO,
        "/dev/null",
        O_RDONLY,
        (mode_t)0
    );
    if (spawn_error == 0) {
        spawn_error = posix_spawn_file_actions_addclose(&actions, output_pipe[0]);
    }
    if (spawn_error == 0) {
        spawn_error = posix_spawn_file_actions_adddup2(
            &actions,
            output_pipe[1],
            STDOUT_FILENO
        );
    }
    if (spawn_error == 0) {
        spawn_error = posix_spawn_file_actions_adddup2(
            &actions,
            output_pipe[1],
            STDERR_FILENO
        );
    }
    if (spawn_error == 0) {
        spawn_error = posix_spawn_file_actions_addclose(&actions, output_pipe[1]);
    }
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
    if (spawn_error == 0) {
        spawn_error = posix_spawnattr_setflags(
            &attributes,
            POSIX_SPAWN_CLOEXEC_DEFAULT
        );
    }
#endif

    pid_t child = 0;
    char *const launch_arguments[] = {
        "/bin/launchctl",
        "kickstart",
        "-k",
        service_target,
        NULL,
    };
    char *const launch_environment[] = {
        "HOME=/var/empty",
        "LANG=C",
        "LC_ALL=C",
        "PATH=/usr/bin:/bin",
        NULL,
    };
    if (spawn_error == 0) {
        spawn_error = posix_spawn(
            &child,
            "/bin/launchctl",
            &actions,
            &attributes,
            launch_arguments,
            launch_environment
        );
    }
    (void)posix_spawn_file_actions_destroy(&actions);
    (void)posix_spawnattr_destroy(&attributes);
    (void)close(output_pipe[1]);
    if (spawn_error != 0) {
        (void)close(output_pipe[0]);
        return (rt_canary_result_t){
            .outcome = rt_permission_denied(spawn_error)
                ? RT_CANARY_OUTCOME_DENIED
                : RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = spawn_error,
        };
    }

    char output[RT_LAUNCHCTL_OUTPUT_BYTES];
    size_t output_length = 0U;
    int status = 0;
    const int wait_error = rt_wait_for_child(
        child,
        output_pipe[0],
        output,
        sizeof(output),
        &output_length,
        &status
    );
    (void)close(output_pipe[0]);
    if (wait_error != 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = wait_error,
        };
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_ALLOWED,
            .code = 0,
        };
    }
    if (WIFEXITED(status) &&
        rt_contains_launchd_denial(
            output,
            output_length,
            WEXITSTATUS(status)
        )) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_DENIED,
            .code = WEXITSTATUS(status),
        };
    }
    return (rt_canary_result_t){
        .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
        .code = WIFEXITED(status) ? WEXITSTATUS(status) : ECHILD,
    };
}

static rt_canary_result_t rt_probe_unix_socket(const char *path) {
    const int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor < 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_INCONCLUSIVE,
            .code = errno,
        };
    }
    (void)fcntl(descriptor, F_SETFD, FD_CLOEXEC);

    struct sockaddr_un address = {
        .sun_family = AF_UNIX,
    };
    const size_t path_length = strlen(path);
    memcpy(address.sun_path, path, path_length + 1U);
    address.sun_len = (uint8_t)SUN_LEN(&address);
    errno = 0;
    const int result = connect(
        descriptor,
        (const struct sockaddr *)&address,
        (socklen_t)address.sun_len
    );
    const int saved_error = errno;
    (void)close(descriptor);
    return rt_result_from_denial_attempt(result, saved_error);
}

static rt_canary_result_t rt_probe_host_canary_read(const char *path) {
    errno = 0;
    const int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    const int saved_error = errno;
    if (descriptor >= 0) {
        unsigned char byte = 0U;
        (void)read(descriptor, &byte, sizeof(byte));
        (void)close(descriptor);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_ALLOWED,
            .code = 0,
        };
    }
    return (rt_canary_result_t){
        .outcome = rt_permission_denied(saved_error)
            ? RT_CANARY_OUTCOME_DENIED
            : RT_CANARY_OUTCOME_INCONCLUSIVE,
        .code = saved_error,
    };
}

static int rt_write_all(int descriptor, const void *bytes, size_t byte_count) {
    const unsigned char *cursor = bytes;
    size_t remaining = byte_count;
    while (remaining > 0U) {
        const ssize_t written = write(descriptor, cursor, remaining);
        if (written > 0) {
            cursor += (size_t)written;
            remaining -= (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        return written == 0 ? EIO : errno;
    }
    return 0;
}

static rt_canary_result_t rt_probe_staging_write(
    const char *staging_directory,
    const char *run_id
) {
    char canonical_directory[RT_ISOLATION_CANARY_MAX_PATH_BYTES + 1U];
    errno = 0;
    if (realpath(staging_directory, canonical_directory) == NULL) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = errno,
        };
    }
    if (strcmp(canonical_directory, staging_directory) != 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = EINVAL,
        };
    }

    const int directory = open(
        canonical_directory,
        O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW
    );
    if (directory < 0) {
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = errno,
        };
    }

    struct stat directory_information = {0};
    if (fstat(directory, &directory_information) != 0) {
        const int saved_error = errno;
        (void)close(directory);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = saved_error,
        };
    }
    if (!S_ISDIR(directory_information.st_mode) ||
        directory_information.st_uid != geteuid() ||
        (directory_information.st_mode & (mode_t)0077) != 0) {
        (void)close(directory);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = EACCES,
        };
    }

    char filename[sizeof(RT_ISOLATION_CANARY_WRITE_PREFIX) +
        RT_ISOLATION_CANARY_RUN_ID_BYTES];
    const int filename_length = snprintf(
        filename,
        sizeof(filename),
        "%s%s",
        RT_ISOLATION_CANARY_WRITE_PREFIX,
        run_id
    );
    if (filename_length <= 0 || (size_t)filename_length >= sizeof(filename)) {
        (void)close(directory);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = EINVAL,
        };
    }

    const int canary = openat(
        directory,
        filename,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        (mode_t)0600
    );
    if (canary < 0) {
        const int saved_error = errno;
        (void)close(directory);
        return (rt_canary_result_t){
            .outcome = RT_CANARY_OUTCOME_FAILED,
            .code = saved_error,
        };
    }

    static const char payload[] =
        "roundtable-service-uid-isolation-canary-v1\n";
    int write_error = rt_write_all(canary, payload, sizeof(payload) - 1U);
    struct stat canary_information = {0};
    if (write_error == 0 && fstat(canary, &canary_information) != 0) {
        write_error = errno;
    }
    if (write_error == 0 &&
        (!S_ISREG(canary_information.st_mode) ||
         canary_information.st_uid != geteuid() ||
         canary_information.st_nlink != 1 ||
         (canary_information.st_mode & (mode_t)0777) != (mode_t)0600)) {
        write_error = EACCES;
    }
    if (write_error == 0 && fsync(canary) != 0) {
        write_error = errno;
    }
    if (close(canary) != 0 && write_error == 0) {
        write_error = errno;
    }
    if (write_error == 0 && fsync(directory) != 0) {
        write_error = errno;
    }
    if (write_error != 0) {
        (void)unlinkat(directory, filename, 0);
    }
    (void)close(directory);
    return (rt_canary_result_t){
        .outcome = write_error == 0
            ? RT_CANARY_OUTCOME_SUCCEEDED
            : RT_CANARY_OUTCOME_FAILED,
        .code = write_error,
    };
}

static bool rt_is_denied(rt_canary_result_t result) {
    return result.outcome == RT_CANARY_OUTCOME_DENIED;
}

static bool rt_is_allowed(rt_canary_result_t result) {
    return result.outcome == RT_CANARY_OUTCOME_ALLOWED;
}

static void rt_print_results(
    const char *overall_result,
    const rt_isolation_canary_input_t *input,
    uid_t service_uid,
    rt_canary_result_t procargs,
    rt_canary_result_t signal_result,
    rt_canary_result_t launchd_control,
    rt_canary_result_t unix_socket,
    rt_canary_result_t host_canary_read,
    rt_canary_result_t staging_write
) {
    (void)printf(
        "{\"schemaVersion\":%u,\"result\":\"%s\","
        "\"hostPid\":%lld,\"hostUid\":%llu,\"serviceUid\":%llu,"
        "\"tests\":{"
        "\"procargs\":{\"outcome\":\"%s\",\"code\":%d},"
        "\"signal\":{\"outcome\":\"%s\",\"code\":%d},"
        "\"launchdControl\":{\"outcome\":\"%s\",\"code\":%d},"
        "\"unixSocket\":{\"outcome\":\"%s\",\"code\":%d},"
        "\"hostCanaryRead\":{\"outcome\":\"%s\",\"code\":%d},"
        "\"stagingWrite\":{\"outcome\":\"%s\",\"code\":%d}}}\n",
        RT_ISOLATION_CANARY_SCHEMA_VERSION,
        overall_result,
        (long long)input->host_pid,
        (unsigned long long)input->host_uid,
        (unsigned long long)service_uid,
        rt_outcome_name(procargs.outcome),
        procargs.code,
        rt_outcome_name(signal_result.outcome),
        signal_result.code,
        rt_outcome_name(launchd_control.outcome),
        launchd_control.code,
        rt_outcome_name(unix_socket.outcome),
        unix_socket.code,
        rt_outcome_name(host_canary_read.outcome),
        host_canary_read.code,
        rt_outcome_name(staging_write.outcome),
        staging_write.code
    );
}

static int rt_run_canary(
    int argument_count,
    const char *const arguments[]
) {
    (void)setvbuf(stdout, NULL, _IONBF, 0U);
    mach_port_t inherited_bootstrap = MACH_PORT_NULL;
    if (task_get_special_port(
            mach_task_self(),
            TASK_BOOTSTRAP_PORT,
            &inherited_bootstrap
        ) != KERN_SUCCESS || inherited_bootstrap != MACH_PORT_NULL) {
        if (inherited_bootstrap != MACH_PORT_NULL) {
            (void)mach_port_deallocate(mach_task_self(), inherited_bootstrap);
        }
        puts("{\"schemaVersion\":1,\"result\":\"invalid_bootstrap_context\"}");
        return 66;
    }
    rt_isolation_canary_input_t input = {0};
    if (!rt_isolation_canary_parse_input(
            argument_count,
            arguments,
            &input
        )) {
        puts("{\"schemaVersion\":1,\"result\":\"invalid_invocation\"}");
        return 64;
    }

    const uid_t service_uid = geteuid();
    if (service_uid == (uid_t)0 || service_uid == input.host_uid ||
        !rt_host_identity_matches(input.host_pid, input.host_uid)) {
        puts("{\"schemaVersion\":1,\"result\":\"invalid_execution_context\"}");
        return 65;
    }

    const rt_canary_result_t procargs = rt_probe_host_procargs(input.host_pid);
    const rt_canary_result_t signal_result = rt_probe_host_signal(input.host_pid);
    const rt_canary_result_t launchd_control = rt_probe_launchd_control(
        input.host_uid,
        input.launchd_label
    );
    const rt_canary_result_t unix_socket = rt_probe_unix_socket(
        input.unix_socket_path
    );
    const rt_canary_result_t host_canary_read = rt_probe_host_canary_read(
        input.host_canary_path
    );
    const rt_canary_result_t staging_write = rt_probe_staging_write(
        input.staging_directory,
        input.run_id
    );

    const bool all_boundaries_denied = rt_is_denied(procargs) &&
        rt_is_denied(signal_result) && rt_is_denied(launchd_control) &&
        rt_is_denied(unix_socket) && rt_is_denied(host_canary_read);
    const bool staging_succeeded =
        staging_write.outcome == RT_CANARY_OUTCOME_SUCCEEDED;
    const bool boundary_violation = rt_is_allowed(procargs) ||
        rt_is_allowed(signal_result) || rt_is_allowed(launchd_control) ||
        rt_is_allowed(unix_socket) || rt_is_allowed(host_canary_read);

    if (all_boundaries_denied && staging_succeeded) {
        rt_print_results(
            "passed",
            &input,
            service_uid,
            procargs,
            signal_result,
            launchd_control,
            unix_socket,
            host_canary_read,
            staging_write
        );
        return 0;
    }
    rt_print_results(
        boundary_violation ? "boundary_violation" : "inconclusive",
        &input,
        service_uid,
        procargs,
        signal_result,
        launchd_control,
        unix_socket,
        host_canary_read,
        staging_write
    );
    return boundary_violation ? 10 : 11;
}

int main(int argument_count, char *arguments[]) {
    if (argument_count > 1 &&
        strcmp(arguments[1], RT_RESTRICTED_WORKER_FLAG) == 0) {
        return rt_run_canary(
            argument_count - 1,
            (const char *const *)&arguments[1]
        );
    }
    if (argument_count < 2 || argument_count > 32) {
        puts("{\"schemaVersion\":1,\"result\":\"invalid_invocation\"}");
        return 64;
    }

    char **worker_arguments = calloc(
        (size_t)argument_count + 2U,
        sizeof(*worker_arguments)
    );
    if (worker_arguments == NULL) return 70;
    worker_arguments[0] = arguments[0];
    worker_arguments[1] = (char *)RT_RESTRICTED_WORKER_FLAG;
    for (int index = 1; index < argument_count; index += 1) {
        worker_arguments[index + 1] = arguments[index];
    }

    posix_spawnattr_t attributes;
    int error = posix_spawnattr_init(&attributes);
    const bool attributes_initialized = error == 0;
    if (error == 0) {
        error = posix_spawnattr_setspecialport_np(
            &attributes,
            MACH_PORT_NULL,
            TASK_BOOTSTRAP_PORT
        );
    }
    pid_t worker = 0;
    if (error == 0) {
        error = posix_spawn(
            &worker,
            arguments[0],
            NULL,
            &attributes,
            worker_arguments,
            environ
        );
    }
    if (attributes_initialized) {
        (void)posix_spawnattr_destroy(&attributes);
    }
    free(worker_arguments);
    if (error != 0) return error;

    int status = 0;
    while (waitpid(worker, &status, 0) < 0) {
        if (errno != EINTR) return 71;
    }
    if (!WIFEXITED(status)) return 72;
    return WEXITSTATUS(status);
}
