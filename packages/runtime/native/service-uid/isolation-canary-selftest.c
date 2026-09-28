#include "isolation-canary-input.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

enum {
    RT_SELFTEST_ARGUMENT_COUNT = 15,
};

static const char *const rt_valid_arguments[RT_SELFTEST_ARGUMENT_COUNT] = {
    "roundtable-service-uid-isolation-canary",
    "--host-pid",
    "4242",
    "--host-uid",
    "501",
    "--launchd-label",
    "com.roundtable.runtime.isolation-canary.host.0123456789abcdef0123456789abcdef",
    "--unix-socket",
    "/private/tmp/roundtable-host/socket",
    "--host-canary",
    "/private/tmp/roundtable-host/private.txt",
    "--staging-directory",
    "/private/tmp/roundtable-seat/staging",
    "--run-id",
    "0123456789abcdef0123456789abcdef",
};

static bool rt_expect(bool condition, const char *name) {
    if (!condition) {
        fprintf(
            stderr,
            "service-uid isolation canary self-test failed: %s\n",
            name
        );
        return false;
    }
    return true;
}

static void rt_copy_arguments(const char **arguments) {
    for (size_t index = 0U; index < RT_SELFTEST_ARGUMENT_COUNT; index += 1U) {
        arguments[index] = rt_valid_arguments[index];
    }
}

static bool rt_reject_with_replacement(
    size_t index,
    const char *replacement
) {
    const char *arguments[RT_SELFTEST_ARGUMENT_COUNT];
    rt_copy_arguments(arguments);
    arguments[index] = replacement;
    rt_isolation_canary_input_t parsed = {0};
    return !rt_isolation_canary_parse_input(
        RT_SELFTEST_ARGUMENT_COUNT,
        arguments,
        &parsed
    );
}

static bool rt_test_exact_valid_input(void) {
    rt_isolation_canary_input_t parsed = {0};
    return rt_expect(
        rt_isolation_canary_parse_input(
            RT_SELFTEST_ARGUMENT_COUNT,
            rt_valid_arguments,
            &parsed
        ) &&
            parsed.host_pid == (pid_t)4242 &&
            parsed.host_uid == (uid_t)501 &&
            strcmp(
                parsed.launchd_label,
                rt_valid_arguments[6]
            ) == 0 &&
            strcmp(parsed.unix_socket_path, rt_valid_arguments[8]) == 0 &&
            strcmp(parsed.host_canary_path, rt_valid_arguments[10]) == 0 &&
            strcmp(parsed.staging_directory, rt_valid_arguments[12]) == 0 &&
            strcmp(parsed.run_id, rt_valid_arguments[14]) == 0,
        "parse exact valid schema"
    );
}

static bool rt_test_argument_schema(void) {
    bool ok = true;
    rt_isolation_canary_input_t parsed = {
        .host_pid = (pid_t)777,
        .host_uid = (uid_t)778,
    };
    ok &= rt_expect(
        !rt_isolation_canary_parse_input(
            RT_SELFTEST_ARGUMENT_COUNT - 2,
            rt_valid_arguments,
            &parsed
        ),
        "reject missing field"
    );
    ok &= rt_expect(
        parsed.host_pid == (pid_t)777 && parsed.host_uid == (uid_t)778,
        "leave output untouched on invalid input"
    );
    ok &= rt_expect(
        !rt_isolation_canary_parse_input(
            RT_SELFTEST_ARGUMENT_COUNT + 1,
            rt_valid_arguments,
            &parsed
        ),
        "reject extra field"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(1U, "--host-uid"),
        "reject reordered or duplicate field"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(13U, "--command"),
        "reject command-like field"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(1U, NULL),
        "reject null schema field"
    );
    return ok;
}

static bool rt_test_numeric_bounds(void) {
    bool ok = true;
    ok &= rt_expect(
        rt_reject_with_replacement(2U, "1"),
        "reject init pid"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(2U, "+42"),
        "reject signed pid"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(2U, "042"),
        "reject noncanonical pid"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(2U, "9999999999999999999999"),
        "reject overflowing pid"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(4U, "0"),
        "reject root host uid"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(4U, "4294967295"),
        "reject invalid uid sentinel"
    );
    return ok;
}

static bool rt_test_label_and_run_id(void) {
    bool ok = true;
    ok &= rt_expect(
        rt_reject_with_replacement(
            6U,
            "com.roundtable.runtime.isolation-canary.host.other"
        ),
        "bind launchd label to run id"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(
            6U,
            "com.apple.system.logger"
        ),
        "reject arbitrary launchd label"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(
            14U,
            "0123456789ABCDEF0123456789ABCDEF"
        ),
        "reject uppercase run id"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(14U, "0123456789abcdef"),
        "reject short run id"
    );
    return ok;
}

static bool rt_test_paths(void) {
    bool ok = true;
    ok &= rt_expect(
        rt_reject_with_replacement(8U, "relative/socket"),
        "reject relative socket"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(8U, "/private/tmp/../socket"),
        "reject socket traversal"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(10U, "/private//canary"),
        "reject empty path component"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(10U, "/private/./canary"),
        "reject dot path component"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(12U, "/private/staging/"),
        "reject trailing slash"
    );
    ok &= rt_expect(
        rt_reject_with_replacement(10U, "/private/bad\ncanary"),
        "reject path control character"
    );

    char oversized_socket[256];
    oversized_socket[0] = '/';
    memset(oversized_socket + 1, 'a', sizeof(oversized_socket) - 2U);
    oversized_socket[sizeof(oversized_socket) - 1U] = '\0';
    ok &= rt_expect(
        rt_reject_with_replacement(8U, oversized_socket),
        "reject oversized unix socket path"
    );
    return ok;
}

int main(void) {
    if (!rt_test_exact_valid_input() || !rt_test_argument_schema() ||
        !rt_test_numeric_bounds() || !rt_test_label_and_run_id() ||
        !rt_test_paths()) {
        return 1;
    }
    puts("service-uid-isolation-canary-v1 self-test ok");
    return 0;
}
