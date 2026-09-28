#include "protocol.h"

#include <string.h>

static const char *const rt_request_keys[] = {
    "probe_contract",
    "probe_version",
    "request_id",
    "operation",
};

static const char *const rt_success_keys[] = {
    "probe_contract",
    "probe_version",
    "request_id",
    "result",
    "capability",
    "broker_version",
    "security_mode",
    "peer_euid",
    "peer_audit_session",
};

static const char *const rt_error_keys[] = {
    "probe_contract",
    "probe_version",
    "request_id",
    "result",
    "error_code",
};

static bool rt_is_known_key(
    const char *key,
    const char *const *known_keys,
    size_t known_key_count
) {
    for (size_t index = 0U; index < known_key_count; index += 1U) {
        if (strcmp(key, known_keys[index]) == 0) {
            return true;
        }
    }
    return false;
}

static bool rt_has_exact_keys(
    xpc_object_t dictionary,
    const char *const *known_keys,
    size_t known_key_count
) {
    if (dictionary == NULL || xpc_get_type(dictionary) != XPC_TYPE_DICTIONARY) {
        return false;
    }

    __block size_t observed_key_count = 0U;
    __block bool all_keys_known = true;
    const bool completed = xpc_dictionary_apply(
        dictionary,
        ^bool(const char *key, xpc_object_t value) {
            (void)value;
            observed_key_count += 1U;
            if (!rt_is_known_key(key, known_keys, known_key_count)) {
                all_keys_known = false;
                return false;
            }
            return true;
        }
    );

    return completed && all_keys_known && observed_key_count == known_key_count;
}

static bool rt_get_uint64(
    xpc_object_t dictionary,
    const char *key,
    uint64_t *value
) {
    xpc_object_t object = xpc_dictionary_get_value(dictionary, key);
    if (object == NULL || xpc_get_type(object) != XPC_TYPE_UINT64) {
        return false;
    }
    *value = xpc_uint64_get_value(object);
    return true;
}

static bool rt_get_bounded_string(
    xpc_object_t dictionary,
    const char *key,
    size_t maximum_length,
    const char **value
) {
    xpc_object_t object = xpc_dictionary_get_value(dictionary, key);
    if (object == NULL || xpc_get_type(object) != XPC_TYPE_STRING) {
        return false;
    }

    const size_t length = xpc_string_get_length(object);
    const char *string = xpc_string_get_string_ptr(object);
    if (string == NULL || length == 0U || length > maximum_length) {
        return false;
    }
    if (strlen(string) != length) {
        return false;
    }
    *value = string;
    return true;
}

static bool rt_request_id_valid(const char *request_id) {
    if (request_id == NULL) {
        return false;
    }

    const size_t length = strnlen(
        request_id,
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES + 1U
    );
    if (length == 0U ||
        length > RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES) {
        return false;
    }

    for (size_t index = 0U; index < length; index += 1U) {
        const unsigned char character = (unsigned char)request_id[index];
        const bool is_digit = character >= (unsigned char)'0' &&
            character <= (unsigned char)'9';
        const bool is_upper = character >= (unsigned char)'A' &&
            character <= (unsigned char)'Z';
        const bool is_lower = character >= (unsigned char)'a' &&
            character <= (unsigned char)'z';
        const bool is_separator = character == (unsigned char)'.' ||
            character == (unsigned char)'_' || character == (unsigned char)'-';
        if (!is_digit && !is_upper && !is_lower && !is_separator) {
            return false;
        }
    }
    return true;
}

static bool rt_security_mode_valid(const char *security_mode) {
    return security_mode != NULL &&
        (strcmp(security_mode, "development-adhoc") == 0 ||
         strcmp(security_mode, "development-adhoc-pinned") == 0 ||
         strcmp(security_mode, "development-signed") == 0 ||
         strcmp(security_mode, "production") == 0);
}

static bool rt_error_code_valid(const char *error_code) {
    return error_code != NULL &&
        (strcmp(
             error_code,
             RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INVALID_REQUEST
         ) == 0 ||
         strcmp(
             error_code,
             RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_UNAUTHORIZED
         ) == 0 ||
         strcmp(error_code, RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INTERNAL) == 0);
}

const char *rt_service_uid_bootstrap_probe_operation_name(
    rt_service_uid_bootstrap_probe_operation_t operation
) {
    switch (operation) {
        case RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING:
            return "ping";
        case RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS:
            return "status";
        case RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_INVALID:
            break;
    }
    return NULL;
}

bool rt_service_uid_bootstrap_probe_populate_request(
    xpc_object_t message,
    const char *request_id,
    rt_service_uid_bootstrap_probe_operation_t operation
) {
    const char *operation_name = rt_service_uid_bootstrap_probe_operation_name(
        operation
    );
    if (message == NULL || xpc_get_type(message) != XPC_TYPE_DICTIONARY ||
        !rt_request_id_valid(request_id) || operation_name == NULL) {
        return false;
    }

    xpc_dictionary_set_string(
        message,
        "probe_contract",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT
    );
    xpc_dictionary_set_uint64(
        message,
        "probe_version",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION
    );
    xpc_dictionary_set_string(message, "request_id", request_id);
    xpc_dictionary_set_string(message, "operation", operation_name);
    return true;
}

bool rt_service_uid_bootstrap_probe_parse_request(
    xpc_object_t message,
    rt_service_uid_bootstrap_probe_request_t *request
) {
    if (request == NULL ||
        !rt_has_exact_keys(
            message,
            rt_request_keys,
            sizeof(rt_request_keys) / sizeof(rt_request_keys[0])
        )) {
        return false;
    }

    uint64_t probe_version = 0U;
    const char *probe_contract = NULL;
    const char *request_id = NULL;
    const char *operation_name = NULL;
    if (!rt_get_bounded_string(
            message,
            "probe_contract",
            32U,
            &probe_contract
        ) ||
        strcmp(probe_contract, RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT) != 0 ||
        !rt_get_uint64(message, "probe_version", &probe_version) ||
        probe_version != RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION ||
        !rt_get_bounded_string(
            message,
            "request_id",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES,
            &request_id
        ) ||
        !rt_request_id_valid(request_id) ||
        !rt_get_bounded_string(message, "operation", 6U, &operation_name)) {
        return false;
    }

    rt_service_uid_bootstrap_probe_operation_t operation =
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_INVALID;
    if (strcmp(operation_name, "ping") == 0) {
        operation = RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING;
    } else if (strcmp(operation_name, "status") == 0) {
        operation = RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS;
    } else {
        return false;
    }

    const size_t request_id_length = strlen(request_id);
    memcpy(request->request_id, request_id, request_id_length + 1U);
    request->operation = operation;
    return true;
}

const char *rt_service_uid_bootstrap_probe_safe_request_id(xpc_object_t message) {
    if (message == NULL || xpc_get_type(message) != XPC_TYPE_DICTIONARY) {
        return "invalid";
    }

    const char *request_id = NULL;
    if (!rt_get_bounded_string(
            message,
            "request_id",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES,
            &request_id
        ) ||
        !rt_request_id_valid(request_id)) {
        return "invalid";
    }
    return request_id;
}

bool rt_service_uid_bootstrap_probe_populate_success(
    xpc_object_t response,
    const rt_service_uid_bootstrap_probe_request_t *request,
    const char *security_mode,
    uint64_t peer_euid,
    uint64_t peer_audit_session
) {
    if (response == NULL || xpc_get_type(response) != XPC_TYPE_DICTIONARY ||
        request == NULL || !rt_request_id_valid(request->request_id) ||
        rt_service_uid_bootstrap_probe_operation_name(request->operation) == NULL ||
        !rt_security_mode_valid(security_mode) || peer_audit_session == 0U) {
        return false;
    }

    xpc_dictionary_set_string(
        response,
        "probe_contract",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT
    );
    xpc_dictionary_set_uint64(
        response,
        "probe_version",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION
    );
    xpc_dictionary_set_string(response, "request_id", request->request_id);
    xpc_dictionary_set_string(response, "result", "ok");
    xpc_dictionary_set_string(
        response,
        "capability",
        rt_service_uid_bootstrap_probe_operation_name(request->operation)
    );
    xpc_dictionary_set_string(
        response,
        "broker_version",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_BROKER_VERSION
    );
    xpc_dictionary_set_string(response, "security_mode", security_mode);
    xpc_dictionary_set_uint64(response, "peer_euid", peer_euid);
    xpc_dictionary_set_uint64(
        response,
        "peer_audit_session",
        peer_audit_session
    );
    return true;
}

bool rt_service_uid_bootstrap_probe_parse_success(
    xpc_object_t response,
    const rt_service_uid_bootstrap_probe_request_t *request,
    const char *expected_security_mode,
    rt_service_uid_bootstrap_probe_success_t *success
) {
    if (request == NULL || success == NULL ||
        !rt_request_id_valid(request->request_id) ||
        !rt_security_mode_valid(expected_security_mode) ||
        !rt_has_exact_keys(
            response,
            rt_success_keys,
            sizeof(rt_success_keys) / sizeof(rt_success_keys[0])
        )) {
        return false;
    }

    uint64_t probe_version = 0U;
    uint64_t peer_euid = 0U;
    uint64_t peer_audit_session = 0U;
    const char *request_id = NULL;
    const char *probe_contract = NULL;
    const char *result = NULL;
    const char *capability = NULL;
    const char *broker_version = NULL;
    const char *security_mode = NULL;
    const char *expected_capability = rt_service_uid_bootstrap_probe_operation_name(
        request->operation
    );

    if (expected_capability == NULL ||
        !rt_get_bounded_string(
            response,
            "probe_contract",
            32U,
            &probe_contract
        ) ||
        strcmp(probe_contract, RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT) != 0 ||
        !rt_get_uint64(response, "probe_version", &probe_version) ||
        probe_version != RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION ||
        !rt_get_bounded_string(
            response,
            "request_id",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES,
            &request_id
        ) ||
        strcmp(request_id, request->request_id) != 0 ||
        !rt_get_bounded_string(response, "result", 5U, &result) ||
        strcmp(result, "ok") != 0 ||
        !rt_get_bounded_string(response, "capability", 6U, &capability) ||
        strcmp(capability, expected_capability) != 0 ||
        !rt_get_bounded_string(response, "broker_version", 64U, &broker_version) ||
        strcmp(
            broker_version,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_BROKER_VERSION
        ) != 0 ||
        !rt_get_bounded_string(response, "security_mode", 32U, &security_mode) ||
        strcmp(security_mode, expected_security_mode) != 0 ||
        !rt_get_uint64(response, "peer_euid", &peer_euid) ||
        !rt_get_uint64(
            response,
            "peer_audit_session",
            &peer_audit_session
        ) ||
        peer_audit_session == 0U) {
        return false;
    }

    success->peer_euid = peer_euid;
    success->peer_audit_session = peer_audit_session;
    return true;
}

bool rt_service_uid_bootstrap_probe_populate_error(
    xpc_object_t response,
    const char *request_id,
    const char *error_code
) {
    if (response == NULL || xpc_get_type(response) != XPC_TYPE_DICTIONARY ||
        !rt_request_id_valid(request_id) || !rt_error_code_valid(error_code)) {
        return false;
    }

    xpc_dictionary_set_string(
        response,
        "probe_contract",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT
    );
    xpc_dictionary_set_uint64(
        response,
        "probe_version",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION
    );
    xpc_dictionary_set_string(response, "request_id", request_id);
    xpc_dictionary_set_string(response, "result", "error");
    xpc_dictionary_set_string(response, "error_code", error_code);
    return true;
}

bool rt_service_uid_bootstrap_probe_parse_error(
    xpc_object_t response,
    const char *expected_request_id,
    const char **error_code
) {
    if (!rt_request_id_valid(expected_request_id) || error_code == NULL ||
        !rt_has_exact_keys(
            response,
            rt_error_keys,
            sizeof(rt_error_keys) / sizeof(rt_error_keys[0])
        )) {
        return false;
    }

    uint64_t probe_version = 0U;
    const char *probe_contract = NULL;
    const char *request_id = NULL;
    const char *result = NULL;
    const char *parsed_error_code = NULL;
    if (!rt_get_bounded_string(
            response,
            "probe_contract",
            32U,
            &probe_contract
        ) ||
        strcmp(probe_contract, RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT) != 0 ||
        !rt_get_uint64(response, "probe_version", &probe_version) ||
        probe_version != RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION ||
        !rt_get_bounded_string(
            response,
            "request_id",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES,
            &request_id
        ) ||
        strcmp(request_id, expected_request_id) != 0 ||
        !rt_get_bounded_string(response, "result", 5U, &result) ||
        strcmp(result, "error") != 0 ||
        !rt_get_bounded_string(
            response,
            "error_code",
            32U,
            &parsed_error_code
        ) ||
        !rt_error_code_valid(parsed_error_code)) {
        return false;
    }

    *error_code = parsed_error_code;
    return true;
}
