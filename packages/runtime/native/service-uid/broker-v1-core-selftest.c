#include "broker-v1-core.h"

#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>

typedef struct { int starts; int stops; int scrubs; } counters_t;

static bool authorize_cb(const rt_service_uid_v1_request_t *request, void *context) {
    (void)request; (void)context; return true;
}
static bool deny_authorize_cb(const rt_service_uid_v1_request_t *request, void *context) {
    (void)request; (void)context; return false;
}
static bool authorize_workload_cb(const rt_service_uid_v1_request_t *request, void *context) {
    (void)request; (void)context; return true;
}

static bool prepare_cb(const rt_service_uid_v1_request_t *request, int secret_fd, void *context) {
    (void)request; (void)secret_fd; (void)context; return true;
}
static bool start_cb(const rt_service_uid_v1_request_t *request, void *context) {
    (void)request; ((counters_t *)context)->starts += 1; return true;
}
static bool stop_cb(const rt_service_uid_v1_request_t *request, bool *tree, bool *empty, void *context) {
    (void)request; ((counters_t *)context)->stops += 1; *tree = true; *empty = true; return true;
}
static bool scrub_cb(const rt_service_uid_v1_request_t *request, bool *absent, void *context) {
    (void)request; ((counters_t *)context)->scrubs += 1; *absent = true; return true;
}
static bool check(bool value, const char *name) {
    if (!value) fprintf(stderr, "service-uid-v1 broker core self-test failed: %s\n", name);
    return value;
}

int main(void) {
    counters_t counters = {0};
    rt_service_uid_v1_broker_core_t broker;
    rt_service_uid_v1_broker_init(&broker, (rt_service_uid_v1_broker_callbacks_t){
        .authorize_workspace_grant = authorize_cb,
        .authorize_workload = authorize_workload_cb,
        .prepare_workload = prepare_cb,
        .start_workload = start_cb, .stop_workload = stop_cb,
        .scrub_secret = scrub_cb, .context = &counters,
    });
    rt_service_uid_v1_request_t request = {0};
    request.type = RT_SERVICE_UID_V1_REQUEST_PREPARE;
    strcpy(request.lease_id, "lease-1"); strcpy(request.execution_id, "execution-1"); strcpy(request.preparation_id, "preparation-1");
    rt_service_uid_v1_broker_core_t unavailable;
    rt_service_uid_v1_broker_init(&unavailable, (rt_service_uid_v1_broker_callbacks_t){0});
    const int rejected_fd = open("/dev/null", O_RDONLY);
    bool rejected = rejected_fd >= 3 &&
        rt_service_uid_v1_broker_handle(&unavailable, &request, rejected_fd) ==
            RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID;
    errno = 0;
    rejected = rejected && fcntl(rejected_fd, F_GETFD) == -1 && errno == EBADF;
    bool ok = check(rejected, "close secret FD on rejected prepare");
    rt_service_uid_v1_broker_core_t denied;
    rt_service_uid_v1_broker_init(&denied, (rt_service_uid_v1_broker_callbacks_t){
        .authorize_workspace_grant = deny_authorize_cb,
        .prepare_workload = prepare_cb,
    });
    const int denied_fd = open("/dev/null", O_RDONLY);
    bool denied_grant = denied_fd >= 3 &&
        rt_service_uid_v1_broker_handle(&denied, &request, denied_fd) ==
            RT_SERVICE_UID_V1_LIFECYCLE_WORKSPACE_GRANT_INVALID;
    errno = 0;
    denied_grant = denied_grant && fcntl(denied_fd, F_GETFD) == -1 && errno == EBADF;
    ok &= check(denied_grant, "reject unauthorized workspace grant and close secret FD");
    rt_service_uid_v1_broker_core_t denied_workload;
    rt_service_uid_v1_broker_init(&denied_workload, (rt_service_uid_v1_broker_callbacks_t){
        .authorize_workspace_grant = authorize_cb,
        .authorize_workload = deny_authorize_cb,
        .prepare_workload = prepare_cb,
    });
    const int denied_workload_fd = open("/dev/null", O_RDONLY);
    bool denied_provider = denied_workload_fd >= 3 &&
        rt_service_uid_v1_broker_handle(&denied_workload, &request, denied_workload_fd) ==
            RT_SERVICE_UID_V1_LIFECYCLE_WORKLOAD_INVALID;
    errno = 0;
    denied_provider = denied_provider && fcntl(denied_workload_fd, F_GETFD) == -1 && errno == EBADF;
    ok &= check(denied_provider, "reject unauthorized workload and close secret FD");
    const int secret_fd = open("/dev/null", O_RDONLY);
    ok &= check(secret_fd >= 3 && rt_service_uid_v1_broker_handle(&broker, &request, secret_fd) == RT_SERVICE_UID_V1_LIFECYCLE_OK, "prepare");
    request.type = RT_SERVICE_UID_V1_REQUEST_START;
    strcpy(request.lease_id, "wrong-lease");
    ok &= check(rt_service_uid_v1_broker_handle(&broker, &request, -1) == RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID && counters.starts == 0, "reject start before callback");
    strcpy(request.lease_id, "lease-1");
    ok &= check(rt_service_uid_v1_broker_handle(&broker, &request, -1) == RT_SERVICE_UID_V1_LIFECYCLE_OK && counters.starts == 1, "start");
    request.type = RT_SERVICE_UID_V1_REQUEST_STOP;
    ok &= check(rt_service_uid_v1_broker_handle(&broker, &request, -1) == RT_SERVICE_UID_V1_LIFECYCLE_OK && counters.stops == 1, "stop");
    request.type = RT_SERVICE_UID_V1_REQUEST_CLEANUP;
    ok &= check(rt_service_uid_v1_broker_handle(&broker, &request, -1) == RT_SERVICE_UID_V1_LIFECYCLE_OK && counters.scrubs == 1 && broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE, "cleanup");
    if (ok) puts("service-uid-v1 broker core self-test ok");
    return ok ? 0 : 1;
}
