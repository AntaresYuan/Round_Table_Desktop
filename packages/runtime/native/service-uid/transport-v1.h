#ifndef ROUNDTABLE_SERVICE_UID_V1_TRANSPORT_H
#define ROUNDTABLE_SERVICE_UID_V1_TRANSPORT_H

#include "protocol-v1.h"

bool rt_service_uid_v1_parse_transport(
    xpc_object_t message,
    rt_service_uid_v1_request_t *request,
    int *secret_fd
);

#endif
