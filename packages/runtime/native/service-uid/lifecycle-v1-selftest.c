#include "lifecycle-v1.h"

#include <stdio.h>

static bool check(bool value, const char *name) {
    if (!value) fprintf(stderr, "service-uid-v1 lifecycle self-test failed: %s\n", name);
    return value;
}

int main(void) {
    bool ok = true;
    rt_service_uid_v1_seat_t seat;
    rt_service_uid_v1_seat_init(&seat);
    ok &= check(rt_service_uid_v1_seat_prepare(&seat, "lease-invalid", "execution-invalid", "preparation-invalid", -1) == RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID &&
        seat.state == RT_SERVICE_UID_V1_SEAT_IDLE, "reject invalid secret descriptor");
    ok &= check(rt_service_uid_v1_seat_prepare(&seat, "lease-1", "execution-1", "preparation-1", 3) == RT_SERVICE_UID_V1_LIFECYCLE_OK, "prepare");
    ok &= check(seat.secret_consumed && seat.state == RT_SERVICE_UID_V1_SEAT_PREPARED, "secret consumed");
    ok &= check(rt_service_uid_v1_seat_start(&seat, "wrong-lease", "execution-1", "preparation-1") == RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID, "lease binding");
    ok &= check(rt_service_uid_v1_seat_start(&seat, "lease-1", "execution-1", "preparation-1") == RT_SERVICE_UID_V1_LIFECYCLE_OK, "start");
    ok &= check(rt_service_uid_v1_seat_stop(&seat, "lease-1", "execution-1", false, true) == RT_SERVICE_UID_V1_LIFECYCLE_OK && seat.state == RT_SERVICE_UID_V1_SEAT_QUARANTINED, "failed stop quarantine");
    ok &= check(rt_service_uid_v1_seat_cleanup(&seat, "lease-1", "execution-1", true) == RT_SERVICE_UID_V1_LIFECYCLE_CLEANUP_UNCONFIRMED, "quarantine cleanup");
    rt_service_uid_v1_seat_init(&seat);
    ok &= check(rt_service_uid_v1_seat_prepare(&seat, "lease-2", "execution-2", "preparation-2", 3) == RT_SERVICE_UID_V1_LIFECYCLE_OK, "second prepare");
    ok &= check(rt_service_uid_v1_seat_start(&seat, "lease-2", "execution-2", "preparation-2") == RT_SERVICE_UID_V1_LIFECYCLE_OK, "second start");
    ok &= check(rt_service_uid_v1_seat_stop(&seat, "lease-2", "execution-2", true, true) == RT_SERVICE_UID_V1_LIFECYCLE_OK, "confirmed stop");
    ok &= check(rt_service_uid_v1_seat_cleanup(&seat, "lease-2", "execution-2", true) == RT_SERVICE_UID_V1_LIFECYCLE_OK && seat.state == RT_SERVICE_UID_V1_SEAT_IDLE, "cleanup");
    if (ok) puts("service-uid-v1 lifecycle self-test ok");
    return ok ? 0 : 1;
}
