#include "isolation-canary-input.h"

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/un.h>

enum {
    RT_ISOLATION_CANARY_ARGUMENT_COUNT = 15,
};

static size_t rt_bounded_length(const char *value, size_t maximum) {
    if (value == NULL) {
        return maximum + 1U;
    }

    size_t length = 0U;
    while (length <= maximum && value[length] != '\0') {
        length += 1U;
    }
    return length;
}

static bool rt_parse_positive_decimal(
    const char *value,
    uint64_t maximum,
    uint64_t *parsed
) {
    if (value == NULL || parsed == NULL || value[0] == '\0' ||
        value[0] == '0') {
        return false;
    }

    uint64_t result = 0U;
    for (size_t index = 0U; value[index] != '\0'; index += 1U) {
        const unsigned char character = (unsigned char)value[index];
        if (character < (unsigned char)'0' ||
            character > (unsigned char)'9') {
            return false;
        }
        const uint64_t digit = (uint64_t)(character - (unsigned char)'0');
        if (result > (maximum - digit) / UINT64_C(10)) {
            return false;
        }
        result = result * UINT64_C(10) + digit;
    }

    if (result == 0U) {
        return false;
    }
    *parsed = result;
    return true;
}

static bool rt_path_component_valid(const char *component, size_t length) {
    if (length == 0U ||
        (length == 1U && component[0] == '.') ||
        (length == 2U && component[0] == '.' && component[1] == '.')) {
        return false;
    }

    for (size_t index = 0U; index < length; index += 1U) {
        const unsigned char character = (unsigned char)component[index];
        if (character < UINT8_C(0x20) || character == UINT8_C(0x7f)) {
            return false;
        }
    }
    return true;
}

static bool rt_absolute_path_valid(const char *path, size_t maximum_length) {
    const size_t length = rt_bounded_length(path, maximum_length);
    if (length < 2U || length > maximum_length || path[0] != '/' ||
        path[length - 1U] == '/') {
        return false;
    }

    size_t component_start = 1U;
    for (size_t index = 1U; index <= length; index += 1U) {
        if (index == length || path[index] == '/') {
            if (!rt_path_component_valid(
                    path + component_start,
                    index - component_start
                )) {
                return false;
            }
            component_start = index + 1U;
        }
    }
    return true;
}

static bool rt_run_id_valid(const char *run_id) {
    if (rt_bounded_length(run_id, RT_ISOLATION_CANARY_RUN_ID_BYTES) !=
        RT_ISOLATION_CANARY_RUN_ID_BYTES) {
        return false;
    }
    for (size_t index = 0U; index < RT_ISOLATION_CANARY_RUN_ID_BYTES;
         index += 1U) {
        const unsigned char character = (unsigned char)run_id[index];
        const bool decimal = character >= (unsigned char)'0' &&
            character <= (unsigned char)'9';
        const bool lower_hex = character >= (unsigned char)'a' &&
            character <= (unsigned char)'f';
        if (!decimal && !lower_hex) {
            return false;
        }
    }
    return true;
}

static bool rt_copy_bounded(
    char *destination,
    size_t destination_size,
    const char *source
) {
    const size_t length = rt_bounded_length(source, destination_size - 1U);
    if (length == 0U || length >= destination_size) {
        return false;
    }
    memcpy(destination, source, length + 1U);
    return true;
}

static bool rt_equals_literal(const char *value, const char *literal) {
    return value != NULL && strcmp(value, literal) == 0;
}

bool rt_isolation_canary_parse_input(
    int argument_count,
    const char *const arguments[],
    rt_isolation_canary_input_t *input
) {
    if (argument_count != RT_ISOLATION_CANARY_ARGUMENT_COUNT ||
        arguments == NULL || input == NULL ||
        !rt_equals_literal(arguments[1], "--host-pid") ||
        !rt_equals_literal(arguments[3], "--host-uid") ||
        !rt_equals_literal(arguments[5], "--launchd-label") ||
        !rt_equals_literal(arguments[7], "--unix-socket") ||
        !rt_equals_literal(arguments[9], "--host-canary") ||
        !rt_equals_literal(arguments[11], "--staging-directory") ||
        !rt_equals_literal(arguments[13], "--run-id")) {
        return false;
    }

    uint64_t host_pid = 0U;
    uint64_t host_uid = 0U;
    const uint64_t maximum_uid = (uint64_t)(uid_t)-1;
    if (!rt_parse_positive_decimal(arguments[2], (uint64_t)INT_MAX, &host_pid) ||
        host_pid <= UINT64_C(1) ||
        !rt_parse_positive_decimal(arguments[4], maximum_uid, &host_uid) ||
        host_uid == maximum_uid ||
        !rt_run_id_valid(arguments[14]) ||
        !rt_absolute_path_valid(
            arguments[8],
            sizeof(((struct sockaddr_un *)0)->sun_path) - 1U
        ) ||
        !rt_absolute_path_valid(
            arguments[10],
            RT_ISOLATION_CANARY_MAX_PATH_BYTES
        ) ||
        !rt_absolute_path_valid(
            arguments[12],
            RT_ISOLATION_CANARY_MAX_PATH_BYTES
        )) {
        return false;
    }

    char expected_label[RT_ISOLATION_CANARY_MAX_LABEL_BYTES + 1U];
    const int label_length = snprintf(
        expected_label,
        sizeof(expected_label),
        "%s%s",
        RT_ISOLATION_CANARY_LABEL_PREFIX,
        arguments[14]
    );
    const size_t observed_label_length = rt_bounded_length(
        arguments[6],
        RT_ISOLATION_CANARY_MAX_LABEL_BYTES
    );
    if (label_length <= 0 || (size_t)label_length >= sizeof(expected_label) ||
        observed_label_length != (size_t)label_length ||
        memcmp(arguments[6], expected_label, (size_t)label_length + 1U) != 0) {
        return false;
    }

    rt_isolation_canary_input_t parsed = {
        .host_pid = (pid_t)host_pid,
        .host_uid = (uid_t)host_uid,
    };
    if (!rt_copy_bounded(
            parsed.launchd_label,
            sizeof(parsed.launchd_label),
            arguments[6]
        ) ||
        !rt_copy_bounded(
            parsed.unix_socket_path,
            sizeof(parsed.unix_socket_path),
            arguments[8]
        ) ||
        !rt_copy_bounded(
            parsed.host_canary_path,
            sizeof(parsed.host_canary_path),
            arguments[10]
        ) ||
        !rt_copy_bounded(
            parsed.staging_directory,
            sizeof(parsed.staging_directory),
            arguments[12]
        ) ||
        !rt_copy_bounded(parsed.run_id, sizeof(parsed.run_id), arguments[14])) {
        return false;
    }

    *input = parsed;
    return true;
}
