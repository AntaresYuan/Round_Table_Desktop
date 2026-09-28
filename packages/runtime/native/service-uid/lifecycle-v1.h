#ifndef ROUNDTABLE_SERVICE_UID_V1_LIFECYCLE_H
#define ROUNDTABLE_SERVICE_UID_V1_LIFECYCLE_H

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    RT_SERVICE_UID_V1_SEAT_IDLE = 0,
    RT_SERVICE_UID_V1_SEAT_PREPARED = 1,
    RT_SERVICE_UID_V1_SEAT_RUNNING = 2,
    RT_SERVICE_UID_V1_SEAT_STOPPED = 3,
    RT_SERVICE_UID_V1_SEAT_QUARANTINED = 4,
} rt_service_uid_v1_seat_state_t;

typedef enum {
    RT_SERVICE_UID_V1_LIFECYCLE_OK = 0,
    RT_SERVICE_UID_V1_LIFECYCLE_SEAT_BUSY,
    RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID,
    RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID,
    RT_SERVICE_UID_V1_LIFECYCLE_WORKSPACE_GRANT_INVALID,
    RT_SERVICE_UID_V1_LIFECYCLE_WORKLOAD_INVALID,
    RT_SERVICE_UID_V1_LIFECYCLE_STATE_INVALID,
    RT_SERVICE_UID_V1_LIFECYCLE_CLEANUP_UNCONFIRMED,
} rt_service_uid_v1_lifecycle_error_t;

typedef struct {
    rt_service_uid_v1_seat_state_t state;
    char lease_id[128U];
    char execution_id[128U];
    char preparation_id[128U];
    bool secret_consumed;
    bool tree_terminated;
    bool uid_processes_empty;
    bool secret_residue_absent;
} rt_service_uid_v1_seat_t;

void rt_service_uid_v1_seat_init(rt_service_uid_v1_seat_t *seat);
bool rt_service_uid_v1_seat_start_authorized(
    const rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id,
    const char *preparation_id
);
bool rt_service_uid_v1_seat_lease_authorized(
    const rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id
);
rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_prepare(
    rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id,
    const char *preparation_id,
    int secret_fd
);
rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_start(
    rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id,
    const char *preparation_id
);
rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_stop(
    rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id,
    bool tree_terminated,
    bool uid_processes_empty
);
rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_cleanup(
    rt_service_uid_v1_seat_t *seat,
    const char *lease_id,
    const char *execution_id,
    bool secret_residue_absent
);

#endif
