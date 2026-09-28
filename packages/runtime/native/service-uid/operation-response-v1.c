#include "operation-response-v1.h"

#include "generated/macos-service-uid-v1-contract.h"

#include <stdint.h>
#include <string.h>

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

static bool bounded_identifier(xpc_object_t d, const char *key) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    if (value == NULL || xpc_get_type(value) != XPC_TYPE_STRING) return false;
    const char *text = xpc_string_get_string_ptr(value);
    const size_t length = xpc_string_get_length(value);
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

static bool common(xpc_object_t response, const rt_service_uid_v1_request_t *request) {
    return response != NULL && request != NULL &&
        string_value(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT) &&
        xpc_get_type(xpc_dictionary_get_value(response, "protocolVersion")) == XPC_TYPE_UINT64 &&
        xpc_uint64_get_value(xpc_dictionary_get_value(response, "protocolVersion")) == RT_MACOS_SERVICE_UID_V1_VERSION &&
        string_value(response, "requestId", request->request_id) &&
        string_value(response, "type", request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE ? "prepare" :
            request->type == RT_SERVICE_UID_V1_REQUEST_START ? "start" :
            request->type == RT_SERVICE_UID_V1_REQUEST_STOP ? "stop" : "cleanup") &&
        bounded_identifier(response, "serviceInstanceId") &&
        xpc_get_type(xpc_dictionary_get_value(response, "brokerUid")) == XPC_TYPE_UINT64 &&
        xpc_uint64_get_value(xpc_dictionary_get_value(response, "brokerUid")) <= UINT64_C(2147483647) &&
        xpc_get_type(xpc_dictionary_get_value(response, "executionUid")) == XPC_TYPE_UINT64 &&
        xpc_uint64_get_value(xpc_dictionary_get_value(response, "executionUid")) <= UINT64_C(2147483647) &&
        xpc_get_type(xpc_dictionary_get_value(response, "ok")) == XPC_TYPE_BOOL;
}

static bool seat(xpc_object_t value, const char *expected_state) {
    static const char *const keys[] = {"state", "leaseId", "executionId"};
    if (!keys_exact(value, keys, 3U) || !string_value(value, "state", expected_state)) return false;
    if (strcmp(expected_state, "idle") == 0) {
        return xpc_get_type(xpc_dictionary_get_value(value, "leaseId")) == XPC_TYPE_NULL &&
            xpc_get_type(xpc_dictionary_get_value(value, "executionId")) == XPC_TYPE_NULL;
    }
    return bounded_identifier(value, "leaseId") && bounded_identifier(value, "executionId");
}

static bool seat_any(xpc_object_t value) {
    static const char *const states[] = {"idle", "prepared", "running", "stopped", "quarantined"};
    static const char *const keys[] = {"state", "leaseId", "executionId"};
    if (!keys_exact(value, keys, 3U)) return false;
    xpc_object_t state = xpc_dictionary_get_value(value, "state");
    if (state == NULL || xpc_get_type(state) != XPC_TYPE_STRING) return false;
    const char *state_text = xpc_string_get_string_ptr(state);
    for (size_t i = 0U; i < sizeof(states) / sizeof(states[0]); i += 1U) {
        if (strcmp(state_text, states[i]) != 0) continue;
        if (strcmp(state_text, "idle") == 0) {
            return xpc_get_type(xpc_dictionary_get_value(value, "leaseId")) == XPC_TYPE_NULL &&
                xpc_get_type(xpc_dictionary_get_value(value, "executionId")) == XPC_TYPE_NULL;
        }
        return bounded_identifier(value, "leaseId") && bounded_identifier(value, "executionId");
    }
    return false;
}

bool rt_service_uid_v1_parse_operation_response(
    xpc_object_t response,
    const rt_service_uid_v1_request_t *request
) {
    if (!common(response, request)) return false;
    const bool ok = xpc_bool_get_value(xpc_dictionary_get_value(response, "ok"));
    if (!ok) {
        static const char *const keys[] = {
            "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
            "executionUid", "type", "ok", "error", "seat",
        };
        if (!keys_exact(response, keys, sizeof(keys) / sizeof(keys[0]))) return false;
        xpc_object_t error = xpc_dictionary_get_value(response, "error");
        if (error == NULL || xpc_get_type(error) != XPC_TYPE_STRING) return false;
        static const char *const errors[] = {
            "seat_busy", "lease_invalid", "workspace_grant_invalid", "workload_invalid",
            "secret_channel_invalid", "cleanup_unconfirmed", "internal_failure",
            "unauthorized", "invalid_request",
        };
        const char *error_text = xpc_string_get_string_ptr(error);
        bool known = false;
        for (size_t i = 0U; i < sizeof(errors) / sizeof(errors[0]); i += 1U) {
            if (strcmp(error_text, errors[i]) == 0) { known = true; break; }
        }
        return known && seat_any(xpc_dictionary_get_value(response, "seat"));
    }

    if (request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE) {
        static const char *const keys[] = {
            "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
            "executionUid", "type", "ok", "leaseId", "executionId", "preparationId",
            "secretChannelState", "seat",
        };
        return keys_exact(response, keys, sizeof(keys) / sizeof(keys[0])) &&
            bounded_identifier(response, "leaseId") && bounded_identifier(response, "executionId") &&
            bounded_identifier(response, "preparationId") &&
            string_value(response, "secretChannelState", "consumed") &&
            seat(xpc_dictionary_get_value(response, "seat"), "prepared");
    }
    if (request->type == RT_SERVICE_UID_V1_REQUEST_START) {
        static const char *const keys[] = {
            "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
            "executionUid", "type", "ok", "leaseId", "executionId", "runId", "seat",
        };
        return keys_exact(response, keys, sizeof(keys) / sizeof(keys[0])) &&
            bounded_identifier(response, "leaseId") && bounded_identifier(response, "executionId") &&
            bounded_identifier(response, "runId") && seat(xpc_dictionary_get_value(response, "seat"), "running");
    }
    if (request->type == RT_SERVICE_UID_V1_REQUEST_STOP) {
        static const char *const keys[] = {
            "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
            "executionUid", "type", "ok", "leaseId", "executionId", "treeTermination",
            "seatUidProcessState", "seat",
        };
        return keys_exact(response, keys, sizeof(keys) / sizeof(keys[0])) &&
            bounded_identifier(response, "leaseId") && bounded_identifier(response, "executionId") &&
            (string_value(response, "treeTermination", "confirmed") || string_value(response, "treeTermination", "failed")) &&
            (string_value(response, "seatUidProcessState", "empty") || string_value(response, "seatUidProcessState", "nonempty-or-unknown")) &&
            (seat(xpc_dictionary_get_value(response, "seat"), "stopped") || seat(xpc_dictionary_get_value(response, "seat"), "quarantined"));
    }
    static const char *const keys[] = {
        "backend", "protocolVersion", "requestId", "serviceInstanceId", "brokerUid",
        "executionUid", "type", "ok", "leaseId", "executionId", "treeTermination",
        "seatUidProcessState", "secretResidue", "seat",
    };
    return keys_exact(response, keys, sizeof(keys) / sizeof(keys[0])) &&
        bounded_identifier(response, "leaseId") && bounded_identifier(response, "executionId") &&
        (string_value(response, "treeTermination", "confirmed") || string_value(response, "treeTermination", "failed")) &&
        (string_value(response, "seatUidProcessState", "empty") || string_value(response, "seatUidProcessState", "nonempty-or-unknown")) &&
        (string_value(response, "secretResidue", "absent") || string_value(response, "secretResidue", "unknown")) &&
        (seat(xpc_dictionary_get_value(response, "seat"), "stopped") || seat(xpc_dictionary_get_value(response, "seat"), "quarantined") || seat(xpc_dictionary_get_value(response, "seat"), "idle"));
}
