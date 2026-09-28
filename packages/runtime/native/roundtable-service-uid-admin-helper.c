#define _DARWIN_C_SOURCE 1

#include <Security/Authorization.h>
#include <Security/AuthorizationTags.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * This binary is the only native entry point for the administrator
 * transaction. It deliberately delegates the journal/state machine to the
 * sealed JS runner, but performs the non-negotiable root and input checks
 * before exec. The helper never accepts a free-form command or flag set.
 */

static bool safe_absolute_path(const char *path) {
    if (path == NULL || path[0] != '/') return false;
    for (const unsigned char *cursor = (const unsigned char *)path;
         *cursor != '\0'; cursor++) {
        if (*cursor < 0x20U || *cursor == 0x7fU) return false;
    }
    return strlen(path) < PATH_MAX;
}

static volatile sig_atomic_t supervised_child = -1;

static void forward_termination_signal(int signal_number) {
    const pid_t child = (pid_t)supervised_child;
    if (child > 0) (void)kill(child, signal_number);
}

static bool install_supervision_signals(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = forward_termination_signal;
    if (sigemptyset(&action.sa_mask) != 0) return false;
    return sigaction(SIGHUP, &action, NULL) == 0 &&
        sigaction(SIGINT, &action, NULL) == 0 &&
        sigaction(SIGTERM, &action, NULL) == 0;
}

static void restore_default_signals(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    (void)sigemptyset(&action.sa_mask);
    (void)sigaction(SIGHUP, &action, NULL);
    (void)sigaction(SIGINT, &action, NULL);
    (void)sigaction(SIGTERM, &action, NULL);
}

static bool basename_is(const char *path, const char *expected) {
    const char *slash = strrchr(path, '/');
    return slash != NULL && strcmp(slash + 1, expected) == 0;
}

static bool same_parent_directory(const char *left, const char *right) {
    const char *left_slash = strrchr(left, '/');
    const char *right_slash = strrchr(right, '/');
    if (left_slash == NULL || right_slash == NULL ||
        (left_slash - left) != (right_slash - right)) return false;
    return strncmp(left, right, (size_t)(left_slash - left)) == 0;
}

static bool sealed_parent_directory(const char *path) {
    const char *slash = strrchr(path, '/');
    if (slash == NULL || slash == path) return false;
    char parent[PATH_MAX];
    const size_t length = (size_t)(slash - path);
    if (length >= sizeof(parent)) return false;
    memcpy(parent, path, length);
    parent[length] = '\0';
    int descriptor = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) return false;
    struct stat info;
    const bool valid = fstat(descriptor, &info) == 0
        && S_ISDIR(info.st_mode)
        && info.st_uid == 0
        && info.st_gid == 0
        && (info.st_mode & 0777) == 0700;
    (void)close(descriptor);
    return valid;
}

static bool sealed_root_file(const char *path) {
    struct stat info;
    int descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) return false;
    const bool valid = fstat(descriptor, &info) == 0
        && S_ISREG(info.st_mode)
        && info.st_uid == 0
        && info.st_gid == 0
        && info.st_nlink == 1
        && (info.st_mode & 0777) == 0500;
    (void)close(descriptor);
    return valid;
}

static bool sealed_authorization_file(const char *path,
                                      AuthorizationExternalForm *form) {
    struct stat info;
    int descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0 || fstat(descriptor, &info) != 0 ||
        !S_ISREG(info.st_mode) || info.st_uid != 0 || info.st_gid != 0 ||
        info.st_nlink != 1 || (info.st_mode & 0777) != 0400 || info.st_size != 65) {
        if (descriptor >= 0) (void)close(descriptor);
        return false;
    }
    char encoded[65];
    size_t used = 0;
    while (used < sizeof(encoded)) {
        const ssize_t count = read(descriptor, encoded + used, sizeof(encoded) - used);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        used += (size_t)count;
    }
    (void)close(descriptor);
    if (used != sizeof(encoded) || encoded[64] != '\n') return false;
    for (size_t index = 0; index < kAuthorizationExternalFormLength; index++) {
        unsigned int byte = 0;
        if (sscanf(&encoded[index * 2], "%2x", &byte) != 1) return false;
        const char high = encoded[index * 2];
        const char low = encoded[index * 2 + 1];
        if (!((high >= '0' && high <= '9') || (high >= 'a' && high <= 'f')) ||
            !((low >= '0' && low <= '9') || (low >= 'a' && low <= 'f'))) {
            return false;
        }
        form->bytes[index] = (char)byte;
    }
    return unlink(path) == 0;
}

static int self_test(void) {
    puts("roundtable-service-uid-admin-helper self-test ok");
    return 0;
}

static bool normalize_root_identity(void) {
    gid_t root_group = 0;
    if (setgroups(1, &root_group) != 0 || setgid(0) != 0 || setuid(0) != 0) {
        return false;
    }
    return getuid() == 0 && geteuid() == 0 && getgid() == 0 && getegid() == 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
    if (geteuid() != 0) {
        fputs("roundtable-service-uid-admin-helper: sealed root transaction required\n", stderr);
        return 77;
    }
    if (!normalize_root_identity()) {
        fputs("roundtable-service-uid-admin-helper: full root identity required\n", stderr);
        return 79;
    }
    if (argc != 5 ||
        !safe_absolute_path(argv[1]) || !safe_absolute_path(argv[2]) ||
        !safe_absolute_path(argv[3]) || !safe_absolute_path(argv[4]) ||
        !basename_is(argv[1], "node") ||
        !basename_is(argv[2], "admin-runner.mjs") ||
        !basename_is(argv[3], "admin-manifest.json") ||
        !basename_is(argv[4], "authorization-external-form.hex") ||
        !same_parent_directory(argv[1], argv[2]) ||
        !same_parent_directory(argv[1], argv[3]) ||
        !same_parent_directory(argv[1], argv[4]) ||
        !sealed_parent_directory(argv[1]) ||
        !sealed_root_file(argv[1]) || !sealed_root_file(argv[2])) {
        fputs("roundtable-service-uid-admin-helper: sealed root transaction required\n", stderr);
        return 77;
    }
    /* The manifest is copied mode 0400 by the caller, so accept that exact
     * mode here and reject links/other ownership before handing it to Node. */
    struct stat manifest_info;
    int manifest_fd = open(argv[3], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (manifest_fd < 0 || fstat(manifest_fd, &manifest_info) != 0 ||
        !S_ISREG(manifest_info.st_mode) || manifest_info.st_uid != 0 ||
        manifest_info.st_gid != 0 || manifest_info.st_nlink != 1 ||
        (manifest_info.st_mode & 0777) != 0400) {
        if (manifest_fd >= 0) (void)close(manifest_fd);
        fputs("roundtable-service-uid-admin-helper: invalid sealed manifest\n", stderr);
        return 77;
    }
    (void)close(manifest_fd);

    AuthorizationExternalForm external_form;
    if (!sealed_authorization_file(argv[4], &external_form)) {
        fputs("roundtable-service-uid-admin-helper: invalid authorization transfer\n", stderr);
        return 77;
    }
    AuthorizationRef authorization = NULL;
    OSStatus authorization_status = AuthorizationCreateFromExternalForm(
        &external_form, &authorization);
    memset(&external_form, 0, sizeof(external_form));
    const char shell_path[] = "/bin/sh";
    AuthorizationItem right_item = {
        kAuthorizationRightExecute, sizeof(shell_path) - 1, (void *)shell_path, 0,
    };
    AuthorizationRights rights = {1, &right_item};
    if (authorization_status == errAuthorizationSuccess) {
        authorization_status = AuthorizationCopyRights(
            authorization, &rights, NULL, kAuthorizationFlagExtendRights, NULL);
    }
    if (authorization_status != errAuthorizationSuccess) {
        if (authorization != NULL) {
            (void)AuthorizationFree(authorization, kAuthorizationFlagDefaults);
        }
        fputs("roundtable-service-uid-admin-helper: authorization transfer rejected\n", stderr);
        return 77;
    }

    char *const child_argv[] = {
        argv[1], argv[2], "--internal-admin-transaction", argv[3], NULL,
    };
    if (!install_supervision_signals()) {
        (void)AuthorizationFree(authorization, kAuthorizationFlagDefaults);
        fputs("roundtable-service-uid-admin-helper: signal supervision failed\n", stderr);
        return 78;
    }
    sigset_t termination_signals;
    sigset_t previous_mask;
    if (sigemptyset(&termination_signals) != 0 ||
        sigaddset(&termination_signals, SIGHUP) != 0 ||
        sigaddset(&termination_signals, SIGINT) != 0 ||
        sigaddset(&termination_signals, SIGTERM) != 0 ||
        sigprocmask(SIG_BLOCK, &termination_signals, &previous_mask) != 0) {
        (void)AuthorizationFree(authorization, kAuthorizationFlagDefaults);
        fputs("roundtable-service-uid-admin-helper: signal supervision failed\n", stderr);
        return 78;
    }
    const pid_t child = fork();
    if (child < 0) {
        (void)sigprocmask(SIG_SETMASK, &previous_mask, NULL);
        (void)AuthorizationFree(authorization, kAuthorizationFlagDefaults);
        (void)fprintf(stderr, "roundtable-service-uid-admin-helper: fork failed: %s\n",
                      strerror(errno));
        return 78;
    }
    if (child == 0) {
        restore_default_signals();
        (void)sigprocmask(SIG_SETMASK, &previous_mask, NULL);
        execv(argv[1], child_argv);
        (void)fprintf(stderr, "roundtable-service-uid-admin-helper: exec failed: %s\n",
                      strerror(errno));
        _exit(78);
    }
    supervised_child = child;
    if (sigprocmask(SIG_SETMASK, &previous_mask, NULL) != 0) {
        (void)kill(child, SIGTERM);
    }
    int child_status = 0;
    pid_t waited;
    do {
        waited = waitpid(child, &child_status, 0);
    } while (waited < 0 && errno == EINTR);
    supervised_child = -1;
    const OSStatus free_status = AuthorizationFree(
        authorization, kAuthorizationFlagDefaults);
    if (waited != child || free_status != errAuthorizationSuccess) {
        fputs("roundtable-service-uid-admin-helper: child supervision failed\n", stderr);
        return 78;
    }
    if (WIFEXITED(child_status)) return WEXITSTATUS(child_status);
    if (WIFSIGNALED(child_status)) return 128 + WTERMSIG(child_status);
    return 78;
}
