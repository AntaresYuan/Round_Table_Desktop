#include "lifecycle-v1.h"

#include <string.h>

static bool copy_id(char *out, size_t size, const char *value) {
    if (value == NULL) return false;
    const size_t length = strnlen(value, size);
    if (length < 2U || length >= size) return false;
    if ((value[0] < 'A' || value[0] > 'Z') && (value[0] < 'a' || value[0] > 'z') &&
        (value[0] < '0' || value[0] > '9')) return false;
    if ((value[length - 1U] < 'A' || value[length - 1U] > 'Z') &&
        (value[length - 1U] < 'a' || value[length - 1U] > 'z') &&
        (value[length - 1U] < '0' || value[length - 1U] > '9')) return false;
    for (size_t i = 0U; i < length; i += 1U) {
        const unsigned char c = (unsigned char)value[i];
        const bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        const bool digit = c >= '0' && c <= '9';
        if (!alpha && !digit && c != '.' && c != '_' && c != ':' && c != '-') return false;
    }
    memcpy(out, value, length + 1U);
    return true;
}

static bool same(const char *left, const char *right) {
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static bool lease_matches(const rt_service_uid_v1_seat_t *seat, const char *lease, const char *execution) {
    return seat != NULL && same(seat->lease_id, lease) && same(seat->execution_id, execution);
}

void rt_service_uid_v1_seat_init(rt_service_uid_v1_seat_t *seat) {
    if (seat == NULL) return;
    memset(seat, 0, sizeof(*seat));
    seat->state = RT_SERVICE_UID_V1_SEAT_IDLE;
}

bool rt_service_uid_v1_seat_start_authorized(
    const rt_service_uid_v1_seat_t *seat, const char *lease_id,
    const char *execution_id, const char *preparation_id
) {
    return seat != NULL && seat->state == RT_SERVICE_UID_V1_SEAT_PREPARED &&
        lease_matches(seat, lease_id, execution_id) &&
        same(seat->preparation_id, preparation_id);
}

bool rt_service_uid_v1_seat_lease_authorized(
    const rt_service_uid_v1_seat_t *seat, const char *lease_id,
    const char *execution_id
) {
    return seat != NULL && lease_matches(seat, lease_id, execution_id);
}

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_prepare(
    rt_service_uid_v1_seat_t *seat, const char *lease_id, const char *execution_id,
    const char *preparation_id, int secret_fd
) {
    if (seat == NULL || seat->state != RT_SERVICE_UID_V1_SEAT_IDLE) return RT_SERVICE_UID_V1_LIFECYCLE_SEAT_BUSY;
    if (secret_fd < 3 || !copy_id(seat->lease_id, sizeof(seat->lease_id), lease_id) ||
        !copy_id(seat->execution_id, sizeof(seat->execution_id), execution_id) ||
        !copy_id(seat->preparation_id, sizeof(seat->preparation_id), preparation_id)) {
        rt_service_uid_v1_seat_init(seat);
        return RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID;
    }
    seat->state = RT_SERVICE_UID_V1_SEAT_PREPARED;
    seat->secret_consumed = true;
    return RT_SERVICE_UID_V1_LIFECYCLE_OK;
}

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_start(
    rt_service_uid_v1_seat_t *seat, const char *lease_id, const char *execution_id,
    const char *preparation_id
) {
    if (!rt_service_uid_v1_seat_start_authorized(seat, lease_id, execution_id, preparation_id)) {
        return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
    }
    seat->state = RT_SERVICE_UID_V1_SEAT_RUNNING;
    return RT_SERVICE_UID_V1_LIFECYCLE_OK;
}

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_stop(
    rt_service_uid_v1_seat_t *seat, const char *lease_id, const char *execution_id,
    bool tree_terminated, bool uid_processes_empty
) {
    if (seat == NULL || seat->state != RT_SERVICE_UID_V1_SEAT_RUNNING ||
        !lease_matches(seat, lease_id, execution_id)) return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
    seat->tree_terminated = tree_terminated;
    seat->uid_processes_empty = uid_processes_empty;
    seat->state = (tree_terminated && uid_processes_empty)
        ? RT_SERVICE_UID_V1_SEAT_STOPPED : RT_SERVICE_UID_V1_SEAT_QUARANTINED;
    return RT_SERVICE_UID_V1_LIFECYCLE_OK;
}

rt_service_uid_v1_lifecycle_error_t rt_service_uid_v1_seat_cleanup(
    rt_service_uid_v1_seat_t *seat, const char *lease_id, const char *execution_id,
    bool secret_residue_absent
) {
    if (seat == NULL || (seat->state != RT_SERVICE_UID_V1_SEAT_STOPPED &&
        seat->state != RT_SERVICE_UID_V1_SEAT_QUARANTINED) ||
        !lease_matches(seat, lease_id, execution_id)) return RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID;
    seat->secret_residue_absent = secret_residue_absent;
    if (seat->state == RT_SERVICE_UID_V1_SEAT_QUARANTINED || !secret_residue_absent ||
        !seat->tree_terminated || !seat->uid_processes_empty) {
        seat->state = RT_SERVICE_UID_V1_SEAT_QUARANTINED;
        return RT_SERVICE_UID_V1_LIFECYCLE_CLEANUP_UNCONFIRMED;
    }
    rt_service_uid_v1_seat_init(seat);
    return RT_SERVICE_UID_V1_LIFECYCLE_OK;
}
