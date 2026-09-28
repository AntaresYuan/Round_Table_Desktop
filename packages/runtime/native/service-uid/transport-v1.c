#include "transport-v1.h"

#include <string.h>
#include <unistd.h>

bool rt_service_uid_v1_parse_transport(
    xpc_object_t message,
    rt_service_uid_v1_request_t *request,
    int *secret_fd
) {
    if (message == NULL || request == NULL || secret_fd == NULL ||
        xpc_get_type(message) != XPC_TYPE_DICTIONARY) return false;
    *secret_fd = -1;
    xpc_object_t logical = xpc_dictionary_create(NULL, NULL, 0U);
    __block bool valid = true;
    __block bool saw_fd = false;
    xpc_dictionary_apply(message, ^bool(const char *key, xpc_object_t value) {
        if (strcmp(key, "secretChannelFd") == 0) {
            if (saw_fd || xpc_get_type(value) != XPC_TYPE_FD) { valid = false; return false; }
            saw_fd = true;
            *secret_fd = xpc_fd_dup(value);
            if (*secret_fd < 0) valid = false;
            return valid;
        }
        xpc_dictionary_set_value(logical, key, value);
        return true;
    });
    if (!valid || !rt_service_uid_v1_parse_request(logical, request)) {
        if (*secret_fd >= 0) close(*secret_fd);
        xpc_release(logical);
        *secret_fd = -1;
        return false;
    }
    if (request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE) {
        if (*secret_fd < 0) {
            xpc_release(logical);
            return false;
        }
    } else if (*secret_fd >= 0) {
        close(*secret_fd);
        *secret_fd = -1;
        xpc_release(logical);
        return false;
    }
    xpc_release(logical);
    return true;
}
