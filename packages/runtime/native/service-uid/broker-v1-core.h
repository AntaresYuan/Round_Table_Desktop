#ifndef ROUNDTABLE_SERVICE_UID_V1_BROKER_CORE_H
#define ROUNDTABLE_SERVICE_UID_V1_BROKER_CORE_H

#include "lifecycle-v1.h"
#include "protocol-v1.h"

typedef struct {
    bool (*authorize_workspace_grant)(const rt_service_uid_v1_request_t *request, void *context);
    bool (*authorize_workload)(const rt_service_uid_v1_request_t *request, void *context);
    bool (*prepare_workload)(const rt_service_uid_v1_request_t *request, int secret_fd, void *context);
    bool (*start_workload)(const rt_service_uid_v1_request_t *request, void *context);
    bool (*stop_workload)(const rt_service_uid_v1_request_t *request, bool *tree_terminated, bool *uid_processes_empty, void *context);
    bool (*scrub_secret)(const rt_service_uid_v1_request_t *request, bool *residue_absent, void *context);
    void *context;
} rt_service_uid_v1_broker_callbacks_t;

typedef struct {
    rt_service_uid_v1_seat_t seat;
    rt_service_uid_v1_broker_callbacks_t callbacks;
} rt_service_uid_v1_broker_core_t;

void rt_service_uid_v1_broker_init(
    rt_service_uid_v1_broker_core_t *broker,
    rt_service_uid_v1_broker_callbacks_t callbacks
);

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_broker_handle(
    rt_service_uid_v1_broker_core_t *broker,
    const rt_service_uid_v1_request_t *request,
    int secret_fd
);

#endif
