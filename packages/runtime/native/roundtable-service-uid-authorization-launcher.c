#define _DARWIN_C_SOURCE 1

#include <Security/Authorization.h>
#include <Security/AuthorizationTags.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * Development-only, single-prompt launcher for the Phase 4 service-UID gate.
 * The launcher does not accept a command. It accepts exactly six named input
 * files and hashes, builds the fixed root sealing recipe itself, and executes
 * only /bin/sh -s. The AuthorizationExternalForm travels inside the private
 * communications pipe and is never placed in argv or the environment.
 */

#define INPUT_COUNT 6
#define SHA256_HEX_LENGTH 64
#define MAX_PATH_LENGTH 1023
#define SCRIPT_CAPACITY (64U * 1024U)

static const char *const package_prefix =
    "/private/var/tmp/roundtable-service-uid-development-gate-admin-";
static const char *const prompt =
    "Round_Table Phase 4 development gate: one bounded transaction will "
    "recover the verified test identity, simulate and recover a test child "
    "crash, run the isolation canary, and remove its temporary resources.";
static const char *const source_basenames[INPUT_COUNT] = {
    "roundtable-service-uid-admin-helper",
    "node",
    "run-service-uid-development-gate.mjs",
    "admin-manifest.json",
    "roundtable-service-uid-bootstrap-probe-v0-broker",
    "roundtable-service-uid-isolation-canary",
};
static const char *const target_basenames[INPUT_COUNT] = {
    "admin-helper", "node", "admin-runner.mjs", "admin-manifest.json",
    "broker", "canary",
};
static const char *const target_modes[INPUT_COUNT] = {
    "0500", "0500", "0500", "0400", "0500", "0500",
};

static bool is_lower_hex(const char *value, size_t length) {
    if (value == NULL || strlen(value) != length) return false;
    for (size_t index = 0; index < length; index++) {
        const char byte = value[index];
        if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) {
            return false;
        }
    }
    return true;
}

static bool is_lower_hex_segment(const char *value, size_t length) {
    if (value == NULL) return false;
    for (size_t index = 0; index < length; index++) {
        const char byte = value[index];
        if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) {
            return false;
        }
    }
    return true;
}

static bool safe_absolute_path(const char *path) {
    if (path == NULL || path[0] != '/' || strlen(path) > MAX_PATH_LENGTH) {
        return false;
    }
    if (strchr(path, '\'') != NULL) return false;
    const char *component = path;
    for (const unsigned char *cursor = (const unsigned char *)path;
         *cursor != '\0'; cursor++) {
        if (*cursor < 0x20U || *cursor == 0x7fU) return false;
        if (*cursor == '/') {
            if ((cursor - (const unsigned char *)component) == 2 &&
                component[0] == '.' && component[1] == '.') return false;
            component = (const char *)cursor + 1;
        }
    }
    return !(strlen(component) == 2 && component[0] == '.' && component[1] == '.');
}

static bool basename_is(const char *path, const char *expected) {
    const char *slash = strrchr(path, '/');
    return slash != NULL && strcmp(slash + 1, expected) == 0;
}

static bool package_path_is_exact(const char *path) {
    if (!safe_absolute_path(path)) return false;
    const size_t prefix_length = strlen(package_prefix);
    if (strncmp(path, package_prefix, prefix_length) != 0) return false;
    const char *suffix = path + prefix_length;
    return strlen(suffix) == 65 && suffix[32] == '-' &&
        is_lower_hex_segment(suffix, 32) &&
        is_lower_hex_segment(suffix + 33, 32);
}

static bool source_file_is_bounded(const char *path, const char *basename) {
    if (!safe_absolute_path(path) || !basename_is(path, basename)) return false;
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1) {
        return false;
    }
    return (info.st_mode & 0022) == 0;
}

static bool append_text(char *buffer, size_t *used, const char *text) {
    const size_t length = strlen(text);
    if (length > SCRIPT_CAPACITY - *used - 1) return false;
    memcpy(buffer + *used, text, length);
    *used += length;
    buffer[*used] = '\0';
    return true;
}

static bool append_format(char *buffer, size_t *used, const char *format,
                          const char *left, const char *right,
                          const char *third) {
    const size_t remaining = SCRIPT_CAPACITY - *used;
    const int written = snprintf(buffer + *used, remaining, format, left, right, third);
    if (written < 0 || (size_t)written >= remaining) return false;
    *used += (size_t)written;
    return true;
}

static void external_form_hex(const AuthorizationExternalForm *form,
                              char output[SHA256_HEX_LENGTH + 1]) {
    static const char alphabet[] = "0123456789abcdef";
    for (size_t index = 0; index < kAuthorizationExternalFormLength; index++) {
        const uint8_t byte = (uint8_t)form->bytes[index];
        output[index * 2] = alphabet[byte >> 4];
        output[index * 2 + 1] = alphabet[byte & 0x0fU];
    }
    output[SHA256_HEX_LENGTH] = '\0';
}

static char *build_script(const char *package_path, char **sources,
                          char **hashes, const char *authorization_hex) {
    char *script = calloc(1, SCRIPT_CAPACITY);
    if (script == NULL) return NULL;
    size_t used = 0;
    char launcher_pid[32];
    (void)snprintf(launcher_pid, sizeof(launcher_pid), "%ld", (long)getpid());
    if (!append_text(script, &used, "set -eu\numask 077\n") ||
        !append_format(script, &used, "package='%s'\nlauncher_pid='%s'\nauthorization='%s'\n",
                       package_path, launcher_pid, authorization_hex) ||
        !append_text(script, &used,
            "child=''\nwatcher=''\n"
            "cleanup() { /bin/rm -rf -- \"$package\"; }\n"
            "terminate() {\n"
            "  if [ -n \"$child\" ]; then /bin/kill -TERM \"$child\" 2>/dev/null || :; fi\n"
            "  if [ -n \"$watcher\" ]; then /bin/kill -TERM \"$watcher\" 2>/dev/null || :; fi\n"
            "  cleanup\n  exit 143\n}\n"
            "trap terminate HUP INT TERM\ntrap cleanup EXIT\n"
            "/bin/mkdir -m 0700 \"$package\"\n"
            "/usr/sbin/chown root:wheel \"$package\"\n")) {
        free(script);
        return NULL;
    }
    for (size_t index = 0; index < INPUT_COUNT; index++) {
        char target[MAX_PATH_LENGTH + 1];
        const int target_length = snprintf(target, sizeof(target), "%s/%s",
                                           package_path, target_basenames[index]);
        if (target_length < 0 || (size_t)target_length >= sizeof(target) ||
            !append_format(script, &used,
                "/usr/bin/install -o root -g wheel -m %s '%s' '%s'\n",
                target_modes[index], sources[index], target) ||
            !append_format(script, &used,
                "/usr/bin/printf '%%s  %%s\\n' '%s' '%s' | /usr/bin/shasum -a 256 -c - >/dev/null 2>&1\n",
                hashes[index], target, "")) {
            free(script);
            return NULL;
        }
    }
    if (!append_text(script, &used,
        "/usr/bin/printf '%s\\n' \"$authorization\" > \"$package/authorization-external-form.hex\"\n"
        "/usr/sbin/chown root:wheel \"$package/authorization-external-form.hex\"\n"
        "/bin/chmod 0400 \"$package/authorization-external-form.hex\"\n"
        "unset authorization\n"
        "\"$package/admin-helper\" \"$package/node\" \"$package/admin-runner.mjs\" "
        "\"$package/admin-manifest.json\" \"$package/authorization-external-form.hex\" &\n"
        "child=$!\n"
        "( while /bin/kill -0 \"$launcher_pid\" 2>/dev/null; do /bin/sleep 1; done; "
        "/bin/kill -TERM \"$child\" 2>/dev/null || : ) &\n"
        "watcher=$!\n"
        "if wait \"$child\"; then status=0; else status=$?; fi\n"
        "/bin/kill -TERM \"$watcher\" 2>/dev/null || :\nwait \"$watcher\" 2>/dev/null || :\n"
        "child=''\nwatcher=''\nexit \"$status\"\n")) {
        free(script);
        return NULL;
    }
    return script;
}

static int self_test(void) {
    char *sources[INPUT_COUNT] = {
        "/private/tmp/roundtable-service-uid-admin-helper",
        "/private/tmp/node",
        "/private/tmp/run-service-uid-development-gate.mjs",
        "/private/tmp/admin-manifest.json",
        "/private/tmp/roundtable-service-uid-bootstrap-probe-v0-broker",
        "/private/tmp/roundtable-service-uid-isolation-canary",
    };
    char hash[] =
        "0000000000000000000000000000000000000000000000000000000000000000";
    char *hashes[INPUT_COUNT] = {hash, hash, hash, hash, hash, hash};
    const char authorization_hex[] =
        "1111111111111111111111111111111111111111111111111111111111111111";
    char *script = build_script(
        "/private/var/tmp/roundtable-service-uid-development-gate-admin-"
        "00000000000000000000000000000000-11111111111111111111111111111111",
        sources, hashes, authorization_hex);
    if (script == NULL || strstr(script, authorization_hex) == NULL ||
        strstr(script, "/bin/sh -c") != NULL) {
        free(script);
        return 70;
    }
    FILE *syntax = popen("/bin/sh -n", "w");
    if (syntax == NULL) {
        memset(script, 0, SCRIPT_CAPACITY);
        free(script);
        return 70;
    }
    const size_t length = strlen(script);
    const bool written = fwrite(script, 1, length, syntax) == length;
    memset(script, 0, SCRIPT_CAPACITY);
    free(script);
    if (!written || pclose(syntax) != 0) return 70;
    puts("roundtable-service-uid-authorization-launcher self-test ok");
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
    if (argc != 14 || !package_path_is_exact(argv[1])) {
        fputs("roundtable-service-uid-authorization-launcher: invalid fixed invocation\n", stderr);
        return 64;
    }
    char *sources[INPUT_COUNT];
    char *hashes[INPUT_COUNT];
    for (size_t index = 0; index < INPUT_COUNT; index++) {
        sources[index] = argv[2 + index * 2];
        hashes[index] = argv[3 + index * 2];
        if (!source_file_is_bounded(sources[index], source_basenames[index]) ||
            !is_lower_hex(hashes[index], SHA256_HEX_LENGTH)) {
            fputs("roundtable-service-uid-authorization-launcher: invalid fixed invocation\n", stderr);
            return 64;
        }
    }

    AuthorizationRef authorization = NULL;
    const char shell_path[] = "/bin/sh";
    AuthorizationItem right_item = {
        kAuthorizationRightExecute, sizeof(shell_path) - 1, (void *)shell_path, 0,
    };
    AuthorizationRights rights = {1, &right_item};
    AuthorizationItem environment_item = {
        kAuthorizationEnvironmentPrompt, strlen(prompt), (void *)prompt, 0,
    };
    AuthorizationEnvironment environment = {1, &environment_item};
    OSStatus status = AuthorizationCreate(NULL, NULL, kAuthorizationFlagDefaults,
                                          &authorization);
    if (status == errAuthorizationSuccess) {
        status = AuthorizationCopyRights(
            authorization, &rights, &environment,
            kAuthorizationFlagInteractionAllowed | kAuthorizationFlagExtendRights,
            NULL);
    }
    AuthorizationExternalForm external_form;
    if (status == errAuthorizationSuccess) {
        status = AuthorizationMakeExternalForm(authorization, &external_form);
    }
    if (status != errAuthorizationSuccess) {
        if (authorization != NULL) {
            (void)AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
        }
        (void)fprintf(stderr,
            "roundtable-service-uid-authorization-launcher: authorization failed: %d\n",
            (int)status);
        return 77;
    }

    char authorization_hex[SHA256_HEX_LENGTH + 1];
    external_form_hex(&external_form, authorization_hex);
    char *script = build_script(argv[1], sources, hashes, authorization_hex);
    memset(authorization_hex, 0, sizeof(authorization_hex));
    memset(&external_form, 0, sizeof(external_form));
    if (script == NULL) {
        (void)AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
        fputs("roundtable-service-uid-authorization-launcher: script construction failed\n", stderr);
        return 70;
    }

    char *const shell_arguments[] = {"-s", NULL};
    FILE *pipe = NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    status = AuthorizationExecuteWithPrivileges(
        authorization, shell_path, kAuthorizationFlagDefaults,
        shell_arguments, &pipe);
#pragma clang diagnostic pop
    if (status != errAuthorizationSuccess || pipe == NULL) {
        memset(script, 0, SCRIPT_CAPACITY);
        free(script);
        (void)AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
        (void)fprintf(stderr,
            "roundtable-service-uid-authorization-launcher: privileged launch failed: %d\n",
            (int)status);
        return 78;
    }

    const size_t script_length = strlen(script);
    const bool wrote_script = fwrite(script, 1, script_length, pipe) == script_length &&
        fflush(pipe) == 0;
    memset(script, 0, SCRIPT_CAPACITY);
    free(script);
    if (!wrote_script) {
        (void)fclose(pipe);
        (void)AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
        fputs("roundtable-service-uid-authorization-launcher: privileged pipe write failed\n", stderr);
        return 74;
    }

    unsigned char output[4096];
    bool output_ok = true;
    while (!feof(pipe)) {
        const size_t count = fread(output, 1, sizeof(output), pipe);
        if (count > 0 && fwrite(output, 1, count, stdout) != count) output_ok = false;
        if (ferror(pipe)) {
            output_ok = false;
            break;
        }
    }
    const int pipe_status = fclose(pipe);
    const OSStatus free_status = AuthorizationFree(
        authorization, kAuthorizationFlagDestroyRights);
    if (!output_ok || pipe_status != 0 || free_status != errAuthorizationSuccess) {
        fputs("roundtable-service-uid-authorization-launcher: transaction channel failed\n", stderr);
        return 74;
    }
    return 0;
}
