#include "protocol-v1.h"

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static bool expect(bool condition, const char *name) {
    if (!condition) fprintf(stderr, "service-uid-v1 self-test failed: %s\n", name);
    return condition;
}

int main(void) {
    bool ok = true;
    xpc_object_t status = xpc_dictionary_create(NULL, NULL, 0U);
    ok &= expect(rt_service_uid_v1_populate_status_request(status, "request-1"), "populate status");
    rt_service_uid_v1_request_t parsed = {0};
    ok &= expect(rt_service_uid_v1_parse_request(status, &parsed), "parse status");
    ok &= expect(parsed.type == RT_SERVICE_UID_V1_REQUEST_STATUS && strcmp(parsed.request_id, "request-1") == 0, "status fields");
    xpc_dictionary_set_string(status, "probe_contract", "bootstrap-probe-v0");
    ok &= expect(!rt_service_uid_v1_parse_request(status, &parsed), "reject bootstrap shape");
    xpc_release(status);
    xpc_object_t built_prepare = xpc_dictionary_create(NULL, NULL, 0U);
    ok &= expect(rt_service_uid_v1_populate_prepare_request(
        built_prepare, "request-built", "lease-built", "execution-built",
        "codex", "grant-built", 4U, "channel-built"), "populate prepare");
    ok &= expect(rt_service_uid_v1_parse_request(built_prepare, &parsed)
        && parsed.type == RT_SERVICE_UID_V1_REQUEST_PREPARE
        && strcmp(parsed.preparation_id, "request-built") == 0, "round-trip prepare");
    ok &= expect(!rt_service_uid_v1_populate_prepare_request(
        built_prepare, "request-built", "lease-built", "execution-built",
        "arbitrary", "grant-built", 4U, "channel-built"), "reject provider");
    int secret_fd = open("/dev/null", O_RDONLY);
    ok &= expect(secret_fd >= 0 && rt_service_uid_v1_attach_secret_fd(built_prepare, secret_fd), "attach secret fd");
    if (secret_fd >= 0) close(secret_fd);
    xpc_release(built_prepare);
    xpc_object_t prepare = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(prepare, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(prepare, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(prepare, "requestId", "request-prepare");
    xpc_dictionary_set_string(prepare, "type", "prepare");
    xpc_dictionary_set_string(prepare, "leaseId", "lease-1");
    xpc_dictionary_set_string(prepare, "executionId", "execution-1");
    xpc_object_t workload = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(workload, "kind", "fixture");
    xpc_dictionary_set_string(workload, "fixture", "lifecycle-v1");
    xpc_dictionary_set_value(prepare, "workload", workload);
    xpc_release(workload);
    xpc_object_t grant = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(grant, "grantId", "grant-1");
    xpc_dictionary_set_uint64(grant, "revision", 1U);
    xpc_dictionary_set_value(prepare, "workspaceGrant", grant);
    xpc_release(grant);
    xpc_object_t secret = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(secret, "channelId", "channel-1");
    xpc_dictionary_set_string(secret, "transport", "inherited-fd");
    xpc_dictionary_set_uint64(secret, "fdIndex", 0U);
    xpc_dictionary_set_string(secret, "consumption", "once");
    xpc_dictionary_set_value(prepare, "secretChannel", secret);
    xpc_release(secret);
    ok &= expect(rt_service_uid_v1_parse_request(prepare, &parsed) &&
        parsed.type == RT_SERVICE_UID_V1_REQUEST_PREPARE &&
        strcmp(parsed.preparation_id, "request-prepare") == 0, "parse prepare");
    xpc_release(prepare);
    xpc_object_t start = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(start, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(start, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(start, "requestId", "request-2");
    xpc_dictionary_set_string(start, "type", "start");
    xpc_dictionary_set_string(start, "leaseId", "lease-1");
    xpc_dictionary_set_string(start, "executionId", "execution-1");
    xpc_dictionary_set_string(start, "preparationId", "preparation-1");
    ok &= expect(rt_service_uid_v1_parse_request(start, &parsed) && parsed.type == RT_SERVICE_UID_V1_REQUEST_START, "parse start");
    xpc_object_t stop = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(stop, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(stop, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(stop, "requestId", "request-3");
    xpc_dictionary_set_string(stop, "type", "stop");
    xpc_dictionary_set_string(stop, "leaseId", "lease-1");
    xpc_dictionary_set_string(stop, "executionId", "execution-1");
    xpc_dictionary_set_string(stop, "reason", "requested");
    ok &= expect(rt_service_uid_v1_parse_request(stop, &parsed) && parsed.type == RT_SERVICE_UID_V1_REQUEST_STOP, "parse stop");
    xpc_object_t cleanup = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(cleanup, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(cleanup, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(cleanup, "requestId", "request-4");
    xpc_dictionary_set_string(cleanup, "type", "cleanup");
    xpc_dictionary_set_string(cleanup, "leaseId", "lease-1");
    xpc_dictionary_set_string(cleanup, "executionId", "execution-1");
    xpc_dictionary_set_string(cleanup, "disposition", "terminate-and-scrub");
    ok &= expect(rt_service_uid_v1_parse_request(cleanup, &parsed) && parsed.type == RT_SERVICE_UID_V1_REQUEST_CLEANUP, "parse cleanup");
    xpc_release(stop);
    xpc_release(cleanup);
    xpc_release(start);
    if (ok) puts("service-uid-v1 protocol self-test ok");
    return ok ? 0 : 1;
}
