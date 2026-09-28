#include "broker-v1-core.h"

#include <unistd.h>

void rt_service_uid_v1_broker_init(
    rt_service_uid_v1_broker_core_t *broker,
    rt_service_uid_v1_broker_callbacks_t callbacks
) {
    if (broker == NULL) return;
    rt_service_uid_v1_seat_init(&broker->seat);
    broker->callbacks = callbacks;
}

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_broker_handle(
    rt_service_uid_v1_broker_core_t *broker,
    const rt_service_uid_v1_request_t *request,
    int secret_fd
) {
    if (broker == NULL || request == NULL) return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
    switch (request->type) {
        case RT_SERVICE_UID_V1_REQUEST_STATUS:
            return RT_SERVICE_UID_V1_LIFECYCLE_OK;
        case RT_SERVICE_UID_V1_REQUEST_PREPARE:
            if (broker->seat.state != RT_SERVICE_UID_V1_SEAT_IDLE ||
                secret_fd < 3 || broker->callbacks.authorize_workspace_grant == NULL ||
                broker->callbacks.prepare_workload == NULL) {
                if (secret_fd >= 3) (void)close(secret_fd);
                return broker->seat.state == RT_SERVICE_UID_V1_SEAT_IDLE
                    ? RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID
                    : RT_SERVICE_UID_V1_LIFECYCLE_SEAT_BUSY;
            }
            if (!broker->callbacks.authorize_workspace_grant(
                    request, broker->callbacks.context)) {
                (void)close(secret_fd);
                return RT_SERVICE_UID_V1_LIFECYCLE_WORKSPACE_GRANT_INVALID;
            }
            if (!broker->callbacks.authorize_workload
                || !broker->callbacks.authorize_workload(
                    request, broker->callbacks.context)) {
                (void)close(secret_fd);
                return RT_SERVICE_UID_V1_LIFECYCLE_WORKLOAD_INVALID;
            }
            const bool prepared = broker->callbacks.prepare_workload(
                request, secret_fd, broker->callbacks.context);
            const rt_service_uid_v1_lifecycle_error_t seat_result = prepared
                ? rt_service_uid_v1_seat_prepare(
                    &broker->seat, request->lease_id, request->execution_id,
                    request->preparation_id, secret_fd)
                : RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID;
            const int close_result = close(secret_fd);
            if (close_result != 0 && seat_result == RT_SERVICE_UID_V1_LIFECYCLE_OK) {
                broker->seat.state = RT_SERVICE_UID_V1_SEAT_QUARANTINED;
                return RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID;
            }
            return seat_result;
        case RT_SERVICE_UID_V1_REQUEST_START:
            if (!rt_service_uid_v1_seat_start_authorized(
                    &broker->seat, request->lease_id, request->execution_id,
                    request->preparation_id)) {
                return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
            }
            if (broker->callbacks.start_workload == NULL ||
                !broker->callbacks.start_workload(request, broker->callbacks.context)) {
                return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
            }
            return rt_service_uid_v1_seat_start(
                &broker->seat, request->lease_id, request->execution_id,
                request->preparation_id);
        case RT_SERVICE_UID_V1_REQUEST_STOP: {
            if (broker->seat.state != RT_SERVICE_UID_V1_SEAT_RUNNING ||
                !rt_service_uid_v1_seat_lease_authorized(
                    &broker->seat, request->lease_id, request->execution_id)) {
                return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
            }
            if (broker->callbacks.stop_workload == NULL) return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
            bool tree_terminated = false;
            bool uid_processes_empty = false;
            if (!broker->callbacks.stop_workload(
                    request, &tree_terminated, &uid_processes_empty,
                    broker->callbacks.context)) return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
            return rt_service_uid_v1_seat_stop(
                &broker->seat, request->lease_id, request->execution_id,
                tree_terminated, uid_processes_empty);
        }
        case RT_SERVICE_UID_V1_REQUEST_CLEANUP: {
            if ((broker->seat.state != RT_SERVICE_UID_V1_SEAT_STOPPED &&
                 broker->seat.state != RT_SERVICE_UID_V1_SEAT_QUARANTINED) ||
                !rt_service_uid_v1_seat_lease_authorized(
                    &broker->seat, request->lease_id, request->execution_id)) {
                return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
            }
            if (broker->callbacks.scrub_secret == NULL) return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
            bool residue_absent = false;
            if (!broker->callbacks.scrub_secret(
                    request, &residue_absent, broker->callbacks.context)) {
                return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
            }
            return rt_service_uid_v1_seat_cleanup(
                &broker->seat, request->lease_id, request->execution_id,
                residue_absent);
        }
        default:
            return RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID;
    }
}
