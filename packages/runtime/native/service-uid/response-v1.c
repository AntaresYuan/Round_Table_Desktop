#include "response-v1.h"

#include "generated/macos-service-uid-v1-contract.h"

#include <stdint.h>
#include <string.h>

bool rt_service_uid_v1_response_identity_matches(
    xpc_object_t response,
    uint64_t expected_broker_uid,
    uint64_t expected_execution_uid
) {
    if (response == NULL || expected_broker_uid == UINT64_MAX ||
        expected_execution_uid == UINT64_MAX) return false;
    xpc_object_t broker_uid = xpc_dictionary_get_value(response, "brokerUid");
    xpc_object_t execution_uid = xpc_dictionary_get_value(response, "executionUid");
    return xpc_get_type(broker_uid) == XPC_TYPE_UINT64
        && xpc_get_type(execution_uid) == XPC_TYPE_UINT64
        && xpc_uint64_get_value(broker_uid) == expected_broker_uid
        && xpc_uint64_get_value(execution_uid) == expected_execution_uid;
}

static bool keys_exact(xpc_object_t d, const char *const *keys, size_t count) {
    if (d == NULL || xpc_get_type(d) != XPC_TYPE_DICTIONARY) return false;
    __block size_t seen = 0U; __block bool known = true;
    const bool complete = xpc_dictionary_apply(d, ^bool(const char *key, xpc_object_t value) {
        (void)value; seen += 1U;
        for (size_t i = 0U; i < count; i += 1U) if (strcmp(key, keys[i]) == 0) return true;
        known = false; return false;
    });
    return complete && known && seen == count;
}

static bool string_value(xpc_object_t d, const char *key, const char *expected) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    return value != NULL && xpc_get_type(value) == XPC_TYPE_STRING &&
        strcmp(xpc_string_get_string_ptr(value), expected) == 0;
}

static bool uint_value(xpc_object_t d, const char *key, uint64_t expected) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    return value != NULL && xpc_get_type(value) == XPC_TYPE_UINT64 && xpc_uint64_get_value(value) == expected;
}

static bool identifier_value(xpc_object_t d, const char *key) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    if (value == NULL || xpc_get_type(value) != XPC_TYPE_STRING) return false;
    const size_t length = xpc_string_get_length(value);
    const char *text = xpc_string_get_string_ptr(value);
    if (text == NULL || length < 2U || length > 127U || strlen(text) != length) return false;
    for (size_t i = 0U; i < length; i += 1U) {
        const unsigned char c = (unsigned char)text[i];
        const bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        const bool digit = c >= '0' && c <= '9';
        if ((!alpha && !digit && c != '.' && c != '_' && c != ':' && c != '-') ||
            (i == 0U && !alpha && !digit) || (i == length - 1U && !alpha && !digit)) return false;
    }
    return true;
}

bool rt_service_uid_v1_parse_status_response(xpc_object_t response, const char *request_id) {
    static const char *const success_keys[] = {
        "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
        "executionUid", "type", "ok", "maxConcurrency", "secretTransport", "seat",
    };
    static const char *const failure_keys[] = {
        "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
        "executionUid", "type", "ok", "error", "seat",
    };
    if (request_id == NULL || response == NULL ||
        !string_value(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT) ||
        !uint_value(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION) ||
        !string_value(response, "requestId", request_id) ||
        !string_value(response, "type", "status") ||
        !identifier_value(response, "serviceInstanceId") ||
        xpc_get_type(xpc_dictionary_get_value(response, "brokerUid")) != XPC_TYPE_UINT64 ||
        xpc_uint64_get_value(xpc_dictionary_get_value(response, "brokerUid")) > UINT64_C(2147483647) ||
        xpc_get_type(xpc_dictionary_get_value(response, "executionUid")) != XPC_TYPE_UINT64 ||
        xpc_uint64_get_value(xpc_dictionary_get_value(response, "executionUid")) > UINT64_C(2147483647) ||
        xpc_get_type(xpc_dictionary_get_value(response, "ok")) != XPC_TYPE_BOOL) return false;
    const bool ok = xpc_bool_get_value(xpc_dictionary_get_value(response, "ok"));
    if (ok) {
        if (!keys_exact(response, success_keys, sizeof(success_keys) / sizeof(success_keys[0])) ||
            !uint_value(response, "maxConcurrency", RT_MACOS_SERVICE_UID_V1_MAX_CONCURRENCY) ||
            !string_value(response, "secretTransport", RT_MACOS_SERVICE_UID_V1_SECRET_TRANSPORT)) return false;
    } else {
        if (!keys_exact(response, failure_keys, sizeof(failure_keys) / sizeof(failure_keys[0]))) return false;
        xpc_object_t error = xpc_dictionary_get_value(response, "error");
        if (error == NULL || xpc_get_type(error) != XPC_TYPE_STRING) return false;
        const char *error_text = xpc_string_get_string_ptr(error);
        static const char *const errors[] = {
            "seat_busy", "lease_invalid", "workspace_grant_invalid", "workload_invalid",
            "secret_channel_invalid", "cleanup_unconfirmed", "internal_failure",
            "unauthorized", "invalid_request",
        };
        bool known_error = false;
        for (size_t index = 0U; index < sizeof(errors) / sizeof(errors[0]); index += 1U) {
            if (strcmp(error_text, errors[index]) == 0) { known_error = true; break; }
        }
        if (!known_error) return false;
    }
    xpc_object_t seat = xpc_dictionary_get_value(response, "seat");
    static const char *const seat_keys[] = {"state", "leaseId", "executionId"};
    if (!keys_exact(seat, seat_keys, 3U)) return false;
    const char *state = xpc_string_get_string_ptr(xpc_dictionary_get_value(seat, "state"));
    if (state == NULL) return false;
    if (strcmp(state, "idle") == 0) {
        return xpc_get_type(xpc_dictionary_get_value(seat, "leaseId")) == XPC_TYPE_NULL &&
            xpc_get_type(xpc_dictionary_get_value(seat, "executionId")) == XPC_TYPE_NULL;
    }
    if (!ok && strcmp(state, "quarantined") == 0) {
        return xpc_get_type(xpc_dictionary_get_value(seat, "leaseId")) == XPC_TYPE_NULL &&
            xpc_get_type(xpc_dictionary_get_value(seat, "executionId")) == XPC_TYPE_NULL;
    }
    return false;
}
