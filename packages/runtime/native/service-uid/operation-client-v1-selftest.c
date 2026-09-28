#include "operation-client-v1.h"

#include <stdio.h>

int main(void) {
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_object_t response = NULL;
    const bool rejected = !rt_service_uid_v1_operation_round_trip(
        request, "", -1, 1U, UINT64_MAX, UINT64_MAX, &response);
    xpc_release(request);
    if (!rejected || response != NULL) {
        fputs("service-uid-v1 operation client self-test failed\n", stderr);
        return 1;
    }
    puts("service-uid-v1 operation client self-test ok");
    return 0;
}
