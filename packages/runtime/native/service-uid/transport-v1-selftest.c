#include "transport-v1.h"

#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    bool ok = true;
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(request, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(request, "protocolVersion", 1U);
    xpc_dictionary_set_string(request, "requestId", "request-1");
    xpc_dictionary_set_string(request, "type", "prepare");
    xpc_dictionary_set_string(request, "leaseId", "lease-1");
    xpc_dictionary_set_string(request, "executionId", "execution-1");
    xpc_object_t workload = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(workload, "kind", "fixture");
    xpc_dictionary_set_string(workload, "fixture", "lifecycle-v1");
    xpc_dictionary_set_value(request, "workload", workload); xpc_release(workload);
    xpc_object_t grant = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(grant, "grantId", "grant-1"); xpc_dictionary_set_uint64(grant, "revision", 1U);
    xpc_dictionary_set_value(request, "workspaceGrant", grant); xpc_release(grant);
    xpc_object_t secret = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(secret, "channelId", "channel-1"); xpc_dictionary_set_string(secret, "transport", "inherited-fd");
    xpc_dictionary_set_uint64(secret, "fdIndex", 0U); xpc_dictionary_set_string(secret, "consumption", "once");
    xpc_dictionary_set_value(request, "secretChannel", secret); xpc_release(secret);
    const int source_fd = open("/dev/null", O_RDONLY);
    xpc_object_t fd_object = xpc_fd_create(source_fd);
    xpc_dictionary_set_value(request, "secretChannelFd", fd_object);
    xpc_release(fd_object);
    close(source_fd);
    rt_service_uid_v1_request_t parsed = {0}; int transferred_fd = -1;
    ok &= rt_service_uid_v1_parse_transport(request, &parsed, &transferred_fd);
    ok &= parsed.type == RT_SERVICE_UID_V1_REQUEST_PREPARE && transferred_fd >= 3;
    if (transferred_fd >= 0) close(transferred_fd);
    xpc_release(request);
    if (ok) puts("service-uid-v1 transport self-test ok");
    return ok ? 0 : 1;
}
