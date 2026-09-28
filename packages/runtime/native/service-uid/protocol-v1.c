#include "protocol-v1.h"

#include <string.h>
#include <unistd.h>

static bool exact_keys(xpc_object_t d, const char *const *keys, size_t count) {
    if (d == NULL || xpc_get_type(d) != XPC_TYPE_DICTIONARY) return false;
    __block size_t seen = 0U;
    __block bool known = true;
    const bool complete = xpc_dictionary_apply(d, ^bool(const char *key, xpc_object_t value) {
        (void)value;
        seen += 1U;
        for (size_t i = 0U; i < count; i += 1U) {
            if (strcmp(key, keys[i]) == 0) return true;
        }
        known = false;
        return false;
    });
    return complete && known && seen == count;
}

static bool text(xpc_object_t d, const char *key, size_t max, char *out) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    if (value == NULL || xpc_get_type(value) != XPC_TYPE_STRING) return false;
    const char *raw = xpc_string_get_string_ptr(value);
    const size_t length = xpc_string_get_length(value);
    if (raw == NULL || length == 0U || length > max || strlen(raw) != length) return false;
    for (size_t i = 0U; i < length; i += 1U) {
        const unsigned char c = (unsigned char)raw[i];
        if (c < 0x21U || c > 0x7eU) return false;
    }
    memcpy(out, raw, length);
    out[length] = '\0';
    return true;
}

static bool identifier(xpc_object_t d, const char *key, char *out) {
    if (!text(d, key, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES, out)) return false;
    const size_t length = strlen(out);
    if (length < 2U) return false;
    for (size_t i = 0U; i < length; i += 1U) {
        const unsigned char c = (unsigned char)out[i];
        const bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        const bool digit = c >= '0' && c <= '9';
        const bool punctuation = c == '.' || c == '_' || c == ':' || c == '-';
        if ((!alpha && !digit && !punctuation) ||
            (i == 0U && (!alpha && !digit)) ||
            (i == length - 1U && (!alpha && !digit))) return false;
    }
    return true;
}

static bool uint64_value(xpc_object_t d, const char *key, uint64_t *out) {
    xpc_object_t value = xpc_dictionary_get_value(d, key);
    if (value == NULL || xpc_get_type(value) != XPC_TYPE_UINT64) return false;
    *out = xpc_uint64_get_value(value);
    return true;
}

static bool base(xpc_object_t d, rt_service_uid_v1_request_t *out, const char *type) {
    char backend[64U] = {0};
    uint64_t version = 0U;
    if (!text(d, "backend", sizeof(backend) - 1U, backend) ||
        strcmp(backend, RT_MACOS_SERVICE_UID_V1_CONTRACT) != 0 ||
        !uint64_value(d, "protocolVersion", &version) ||
        version != RT_MACOS_SERVICE_UID_V1_VERSION ||
        !text(d, "type", 16U, backend) || strcmp(backend, type) != 0 ||
        !text(d, "requestId", RT_SERVICE_UID_V1_MAX_REQUEST_ID_BYTES, out->request_id)) return false;
    return true;
}

static bool parse_prepare(xpc_object_t d, rt_service_uid_v1_request_t *out) {
    static const char *const keys[] = {
        "backend", "protocolVersion", "requestId", "type", "leaseId", "executionId",
        "workload", "workspaceGrant", "secretChannel",
    };
    if (!exact_keys(d, keys, sizeof(keys) / sizeof(keys[0])) || !base(d, out, "prepare") ||
        !identifier(d, "leaseId", out->lease_id) || !identifier(d, "executionId", out->execution_id)) return false;
    xpc_object_t workload = xpc_dictionary_get_value(d, "workload");
    if (workload == NULL || !text(workload, "kind", 15U, out->workload_kind)) return false;
    if (strcmp(out->workload_kind, "provider") == 0) {
        static const char *const workload_keys[] = {"kind", "provider"};
        if (!exact_keys(workload, workload_keys, 2U)) return false;
        if (!text(workload, "provider", 31U, out->provider) ||
            (strcmp(out->provider, "codex") != 0 && strcmp(out->provider, "claude-code") != 0)) return false;
    } else if (strcmp(out->workload_kind, "fixture") == 0) {
        static const char *const workload_keys[] = {"kind", "fixture"};
        if (!exact_keys(workload, workload_keys, 2U) ||
            !text(workload, "fixture", 31U, out->provider) || strcmp(out->provider, "lifecycle-v1") != 0) return false;
    } else return false;
    xpc_object_t grant = xpc_dictionary_get_value(d, "workspaceGrant");
    static const char *const grant_keys[] = {"grantId", "revision"};
    if (!exact_keys(grant, grant_keys, 2U) || !identifier(grant, "grantId", out->grant_id) ||
        !uint64_value(grant, "revision", &out->grant_revision) || out->grant_revision == 0U || out->grant_revision > 2147483647U) return false;
    xpc_object_t secret = xpc_dictionary_get_value(d, "secretChannel");
    static const char *const secret_keys[] = {"channelId", "transport", "fdIndex", "consumption"};
    char value[32U] = {0};
    if (!exact_keys(secret, secret_keys, 4U) || !identifier(secret, "channelId", out->secret_channel_id) ||
        !text(secret, "transport", sizeof(value) - 1U, value) || strcmp(value, "inherited-fd") != 0 ||
        !uint64_value(secret, "fdIndex", &out->secret_fd_index) || out->secret_fd_index != 0U ||
        !text(secret, "consumption", sizeof(value) - 1U, value) || strcmp(value, "once") != 0) return false;
    /* v1 prepare deliberately has no caller-supplied preparationId. Bind the
     * broker's one-shot preparation handle to the unique request id; the
     * response must echo this value for the subsequent start request. */
    memcpy(out->preparation_id, out->request_id, sizeof(out->preparation_id));
    return true;
}

bool rt_service_uid_v1_parse_request(xpc_object_t message, rt_service_uid_v1_request_t *request) {
    if (request == NULL || message == NULL) return false;
    rt_service_uid_v1_request_t parsed = {0};
    char type[16U] = {0};
    if (!text(message, "type", sizeof(type) - 1U, type)) return false;
    if (strcmp(type, "prepare") == 0) {
        if (!parse_prepare(message, &parsed)) return false;
    } else if (strcmp(type, "status") == 0) {
        static const char *const keys[] = {"backend", "protocolVersion", "requestId", "type"};
        if (!exact_keys(message, keys, 4U) || !base(message, &parsed, "status")) return false;
        parsed.type = RT_SERVICE_UID_V1_REQUEST_STATUS;
    } else if (strcmp(type, "start") == 0 || strcmp(type, "stop") == 0 || strcmp(type, "cleanup") == 0) {
        static const char *const lifecycle_keys[] = {
            "backend", "protocolVersion", "requestId", "type", "leaseId", "executionId",
            "preparationId",
        };
        static const char *const stop_keys[] = {
            "backend", "protocolVersion", "requestId", "type", "leaseId", "executionId", "reason",
        };
        static const char *const cleanup_keys[] = {
            "backend", "protocolVersion", "requestId", "type", "leaseId", "executionId", "disposition",
        };
        const char *const *keys = strcmp(type, "start") == 0 ? lifecycle_keys :
            (strcmp(type, "stop") == 0 ? stop_keys : cleanup_keys);
        const size_t key_count = strcmp(type, "start") == 0 ? 7U : 7U;
        if (!exact_keys(message, keys, key_count) || !base(message, &parsed, type) ||
            !identifier(message, "leaseId", parsed.lease_id) || !identifier(message, "executionId", parsed.execution_id)) return false;
        if (strcmp(type, "start") == 0) {
            if (!identifier(message, "preparationId", parsed.preparation_id)) return false;
            parsed.type = RT_SERVICE_UID_V1_REQUEST_START;
        } else if (strcmp(type, "stop") == 0) {
            if (!text(message, "reason", sizeof(parsed.stop_reason) - 1U, parsed.stop_reason) ||
                (strcmp(parsed.stop_reason, "requested") != 0 && strcmp(parsed.stop_reason, "shutdown") != 0 && strcmp(parsed.stop_reason, "timeout") != 0)) return false;
            parsed.type = RT_SERVICE_UID_V1_REQUEST_STOP;
        } else {
            char disposition[32U] = {0};
            if (!text(message, "disposition", sizeof(disposition) - 1U, disposition) || strcmp(disposition, "terminate-and-scrub") != 0) return false;
            parsed.type = RT_SERVICE_UID_V1_REQUEST_CLEANUP;
        }
    } else return false;
    if (strcmp(type, "prepare") == 0) parsed.type = RT_SERVICE_UID_V1_REQUEST_PREPARE;
    *request = parsed;
    return true;
}

bool rt_service_uid_v1_populate_status_request(xpc_object_t message, const char *request_id) {
    if (message == NULL || xpc_get_type(message) != XPC_TYPE_DICTIONARY || request_id == NULL) return false;
    xpc_dictionary_set_string(message, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(message, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(message, "requestId", request_id);
    xpc_dictionary_set_string(message, "type", "status");
    return true;
}

static bool outbound_id(const char *value, size_t maximum) {
    if (value == NULL) return false;
    const size_t length = strlen(value);
    if (length < 2U || length > maximum) return false;
    for (size_t i = 0U; i < length; i += 1U) {
        const unsigned char c = (unsigned char)value[i];
        const bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        const bool digit = c >= '0' && c <= '9';
        const bool punctuation = c == '.' || c == '_' || c == ':' || c == '-';
        if ((!alpha && !digit && !punctuation) ||
            (i == 0U && !alpha && !digit) ||
            (i == length - 1U && !alpha && !digit)) return false;
    }
    return true;
}

static bool outbound_base(xpc_object_t message, const char *request_id, const char *type) {
    if (message == NULL || xpc_get_type(message) != XPC_TYPE_DICTIONARY
        || !outbound_id(request_id, RT_SERVICE_UID_V1_MAX_REQUEST_ID_BYTES)
        || type == NULL) return false;
    xpc_dictionary_set_string(message, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(message, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(message, "requestId", request_id);
    xpc_dictionary_set_string(message, "type", type);
    return true;
}

bool rt_service_uid_v1_populate_prepare_request(
    xpc_object_t message, const char *request_id, const char *lease_id,
    const char *execution_id, const char *provider, const char *grant_id,
    uint64_t grant_revision, const char *secret_channel_id
) {
    if (!outbound_base(message, request_id, "prepare")
        || !outbound_id(lease_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(execution_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(provider, 31U)
        || !outbound_id(grant_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || grant_revision == 0U || grant_revision > UINT64_C(2147483647)
        || !outbound_id(secret_channel_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || (strcmp(provider, "codex") != 0 && strcmp(provider, "claude-code") != 0)) return false;
    xpc_dictionary_set_string(message, "leaseId", lease_id);
    xpc_dictionary_set_string(message, "executionId", execution_id);
    xpc_object_t workload = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(workload, "kind", "provider");
    xpc_dictionary_set_string(workload, "provider", provider);
    xpc_dictionary_set_value(message, "workload", workload);
    xpc_release(workload);
    xpc_object_t grant = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(grant, "grantId", grant_id);
    xpc_dictionary_set_uint64(grant, "revision", grant_revision);
    xpc_dictionary_set_value(message, "workspaceGrant", grant);
    xpc_release(grant);
    xpc_object_t secret = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(secret, "channelId", secret_channel_id);
    xpc_dictionary_set_string(secret, "transport", "inherited-fd");
    xpc_dictionary_set_uint64(secret, "fdIndex", 0U);
    xpc_dictionary_set_string(secret, "consumption", "once");
    xpc_dictionary_set_value(message, "secretChannel", secret);
    xpc_release(secret);
    return true;
}

bool rt_service_uid_v1_populate_start_request(
    xpc_object_t message, const char *request_id, const char *lease_id,
    const char *execution_id, const char *preparation_id
) {
    if (!outbound_base(message, request_id, "start")
        || !outbound_id(lease_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(execution_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(preparation_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)) return false;
    xpc_dictionary_set_string(message, "leaseId", lease_id);
    xpc_dictionary_set_string(message, "executionId", execution_id);
    xpc_dictionary_set_string(message, "preparationId", preparation_id);
    return true;
}

bool rt_service_uid_v1_populate_stop_request(
    xpc_object_t message, const char *request_id, const char *lease_id,
    const char *execution_id, const char *reason
) {
    if (!outbound_base(message, request_id, "stop")
        || !outbound_id(lease_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(execution_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || reason == NULL
        || (strcmp(reason, "requested") != 0 && strcmp(reason, "shutdown") != 0 && strcmp(reason, "timeout") != 0)) return false;
    xpc_dictionary_set_string(message, "leaseId", lease_id);
    xpc_dictionary_set_string(message, "executionId", execution_id);
    xpc_dictionary_set_string(message, "reason", reason);
    return true;
}

bool rt_service_uid_v1_populate_cleanup_request(
    xpc_object_t message, const char *request_id, const char *lease_id,
    const char *execution_id
) {
    if (!outbound_base(message, request_id, "cleanup")
        || !outbound_id(lease_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)
        || !outbound_id(execution_id, RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES)) return false;
    xpc_dictionary_set_string(message, "leaseId", lease_id);
    xpc_dictionary_set_string(message, "executionId", execution_id);
    xpc_dictionary_set_string(message, "disposition", "terminate-and-scrub");
    return true;
}

bool rt_service_uid_v1_attach_secret_fd(xpc_object_t message, int secret_fd) {
    if (message == NULL || xpc_get_type(message) != XPC_TYPE_DICTIONARY || secret_fd < 0) return false;
    xpc_dictionary_set_fd(message, "secretChannelFd", secret_fd);
    return true;
}
