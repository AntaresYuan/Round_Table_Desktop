#include "protocol-v1.h"
#include "lifecycle-v1.h"
#include "response-v1.h"
#include "operation-response-v1.h"
#include "broker-v1-core.h"
#include "transport-v1.h"

#include <Security/SecCode.h>
#include <Security/SecBase.h>
#include <bsm/audit.h>
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <uuid/uuid.h>
#include <xpc/xpc.h>

#ifndef RT_SERVICE_UID_V1_ACCEPTED_PEER_REQUIREMENT
#define RT_SERVICE_UID_V1_ACCEPTED_PEER_REQUIREMENT ""
#endif
#ifndef RT_SERVICE_UID_V1_EXECUTION_UID
#define RT_SERVICE_UID_V1_EXECUTION_UID 0U
#endif
#ifndef RT_SERVICE_UID_V1_CLIENT_UID
#define RT_SERVICE_UID_V1_CLIENT_UID UINT32_MAX
#endif

static char service_instance_id[64U];
static rt_service_uid_v1_broker_core_t broker;

static bool peer_code_valid(xpc_object_t message) {
    SecCodeRef sender = NULL;
    if (SecCodeCreateWithXPCMessage(message, kSecCSDefaultFlags, &sender) != errSecSuccess || sender == NULL) return false;
    const OSStatus status = SecCodeCheckValidity(sender, kSecCSDefaultFlags, NULL);
    CFRelease(sender);
    return status == errSecSuccess;
}

static void send_status(xpc_connection_t peer, xpc_object_t message, const rt_service_uid_v1_request_t *request) {
    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) return;
    xpc_dictionary_set_string(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(response, "requestId", request->request_id);
    xpc_dictionary_set_string(response, "serviceInstanceId", service_instance_id);
    xpc_dictionary_set_uint64(response, "brokerUid", (uint64_t)geteuid());
    xpc_dictionary_set_uint64(response, "executionUid", RT_SERVICE_UID_V1_EXECUTION_UID);
    xpc_dictionary_set_string(response, "type", "status");
    xpc_dictionary_set_bool(response, "ok", true);
    xpc_dictionary_set_uint64(response, "maxConcurrency", RT_MACOS_SERVICE_UID_V1_MAX_CONCURRENCY);
    xpc_dictionary_set_string(response, "secretTransport", RT_MACOS_SERVICE_UID_V1_SECRET_TRANSPORT);
    xpc_object_t snapshot = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(snapshot, "state", broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE ? "idle" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_PREPARED ? "prepared" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_RUNNING ? "running" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_STOPPED ? "stopped" : "quarantined");
    if (broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE) {
        xpc_dictionary_set_value(snapshot, "leaseId", xpc_null_create());
        xpc_dictionary_set_value(snapshot, "executionId", xpc_null_create());
    } else {
        xpc_dictionary_set_string(snapshot, "leaseId", broker.seat.lease_id);
        xpc_dictionary_set_string(snapshot, "executionId", broker.seat.execution_id);
    }
    xpc_dictionary_set_value(response, "seat", snapshot);
    xpc_release(snapshot);
    if (!rt_service_uid_v1_parse_status_response(response, request->request_id)) {
        xpc_release(response);
        return;
    }
    xpc_connection_send_message(peer, response);
    xpc_release(response);
}

static void send_failure(xpc_connection_t peer, xpc_object_t message, const char *request_id, const char *error) {
    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) return;
    xpc_dictionary_set_string(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(response, "requestId", request_id == NULL ? "invalid" : request_id);
    xpc_dictionary_set_string(response, "serviceInstanceId", service_instance_id);
    xpc_dictionary_set_uint64(response, "brokerUid", (uint64_t)geteuid());
    xpc_dictionary_set_uint64(response, "executionUid", RT_SERVICE_UID_V1_EXECUTION_UID);
    xpc_dictionary_set_string(response, "type", "status");
    xpc_dictionary_set_bool(response, "ok", false);
    xpc_dictionary_set_string(response, "error", error);
    xpc_object_t snapshot = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(snapshot, "state", "quarantined");
    xpc_dictionary_set_value(snapshot, "leaseId", xpc_null_create());
    xpc_dictionary_set_value(snapshot, "executionId", xpc_null_create());
    xpc_dictionary_set_value(response, "seat", snapshot);
    xpc_release(snapshot);
    if (!rt_service_uid_v1_parse_status_response(
            response,
            request_id == NULL ? "invalid" : request_id)) {
        xpc_release(response);
        return;
    }
    xpc_connection_send_message(peer, response);
    xpc_release(response);
}

static void send_operation_failure(
    xpc_connection_t peer,
    xpc_object_t message,
    const rt_service_uid_v1_request_t *request,
    const char *error
) {
    if (request == NULL) return;
    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) return;
    xpc_dictionary_set_string(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(response, "requestId", request->request_id);
    xpc_dictionary_set_string(response, "serviceInstanceId", service_instance_id);
    xpc_dictionary_set_uint64(response, "brokerUid", (uint64_t)geteuid());
    xpc_dictionary_set_uint64(response, "executionUid", RT_SERVICE_UID_V1_EXECUTION_UID);
    const char *type = request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE ? "prepare" :
        request->type == RT_SERVICE_UID_V1_REQUEST_START ? "start" :
        request->type == RT_SERVICE_UID_V1_REQUEST_STOP ? "stop" : "cleanup";
    xpc_dictionary_set_string(response, "type", type);
    xpc_dictionary_set_bool(response, "ok", false);
    xpc_dictionary_set_string(response, "error", error);
    xpc_object_t snapshot = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(snapshot, "state", "quarantined");
    xpc_dictionary_set_string(snapshot, "leaseId", request->lease_id);
    xpc_dictionary_set_string(snapshot, "executionId", request->execution_id);
    xpc_dictionary_set_value(response, "seat", snapshot);
    xpc_release(snapshot);
    if (!rt_service_uid_v1_parse_operation_response(response, request)) {
        xpc_release(response);
        return;
    }
    xpc_connection_send_message(peer, response);
    xpc_release(response);
}

static void send_operation_success(
    xpc_connection_t peer,
    xpc_object_t message,
    const rt_service_uid_v1_request_t *request
) {
    if (peer == NULL || message == NULL || request == NULL) return;
    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) return;
    xpc_dictionary_set_string(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(response, "requestId", request->request_id);
    xpc_dictionary_set_string(response, "serviceInstanceId", service_instance_id);
    xpc_dictionary_set_uint64(response, "brokerUid", (uint64_t)geteuid());
    xpc_dictionary_set_uint64(response, "executionUid", RT_SERVICE_UID_V1_EXECUTION_UID);
    const char *type = request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE ? "prepare" :
        request->type == RT_SERVICE_UID_V1_REQUEST_START ? "start" :
        request->type == RT_SERVICE_UID_V1_REQUEST_STOP ? "stop" : "cleanup";
    xpc_dictionary_set_string(response, "type", type);
    xpc_dictionary_set_bool(response, "ok", true);
    xpc_dictionary_set_string(response, "leaseId", request->lease_id);
    xpc_dictionary_set_string(response, "executionId", request->execution_id);
    if (request->type == RT_SERVICE_UID_V1_REQUEST_PREPARE) {
        xpc_dictionary_set_string(response, "preparationId", request->preparation_id);
        xpc_dictionary_set_string(response, "secretChannelState", "consumed");
    } else if (request->type == RT_SERVICE_UID_V1_REQUEST_START) {
        /* v1 has no provider PID in the wire contract; the broker request id
         * is the opaque run handle until the workload callback reports one. */
        xpc_dictionary_set_string(response, "runId", request->request_id);
    } else {
        xpc_dictionary_set_string(response, "treeTermination",
            (request->type == RT_SERVICE_UID_V1_REQUEST_CLEANUP &&
             broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE) || broker.seat.tree_terminated
                ? "confirmed" : "failed");
        xpc_dictionary_set_string(response, "seatUidProcessState",
            (request->type == RT_SERVICE_UID_V1_REQUEST_CLEANUP &&
             broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE) || broker.seat.uid_processes_empty
                ? "empty" : "nonempty-or-unknown");
        if (request->type == RT_SERVICE_UID_V1_REQUEST_CLEANUP) {
            xpc_dictionary_set_string(response, "secretResidue",
                broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE || broker.seat.secret_residue_absent
                    ? "absent" : "unknown");
        }
    }
    const char *state = broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE ? "idle" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_PREPARED ? "prepared" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_RUNNING ? "running" :
        broker.seat.state == RT_SERVICE_UID_V1_SEAT_STOPPED ? "stopped" : "quarantined";
    xpc_object_t snapshot = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(snapshot, "state", state);
    if (broker.seat.state == RT_SERVICE_UID_V1_SEAT_IDLE) {
        xpc_dictionary_set_value(snapshot, "leaseId", xpc_null_create());
        xpc_dictionary_set_value(snapshot, "executionId", xpc_null_create());
    } else {
        xpc_dictionary_set_string(snapshot, "leaseId", broker.seat.lease_id);
        xpc_dictionary_set_string(snapshot, "executionId", broker.seat.execution_id);
    }
    xpc_dictionary_set_value(response, "seat", snapshot);
    xpc_release(snapshot);
    if (rt_service_uid_v1_parse_operation_response(response, request)) {
        xpc_connection_send_message(peer, response);
    }
    xpc_release(response);
}

static void handle_message(xpc_connection_t peer, xpc_object_t message) {
    if (!peer_code_valid(message)) {
        send_failure(peer, message, NULL, "unauthorized");
        xpc_connection_cancel(peer);
        return;
    }
    rt_service_uid_v1_request_t request = {0};
    int secret_fd = -1;
    if (!rt_service_uid_v1_parse_transport(message, &request, &secret_fd)) {
        send_failure(peer, message, NULL, "invalid_request");
        return;
    }
    if (request.type == RT_SERVICE_UID_V1_REQUEST_STATUS) {
        if (secret_fd >= 0) close(secret_fd);
        send_status(peer, message, &request);
        return;
    }
    const rt_service_uid_v1_lifecycle_error_t result =
        rt_service_uid_v1_broker_handle(&broker, &request, secret_fd);
    if (result != RT_SERVICE_UID_V1_LIFECYCLE_OK) {
        const char *error = result == RT_SERVICE_UID_V1_LIFECYCLE_SEAT_BUSY ? "seat_busy" :
            result == RT_SERVICE_UID_V1_LIFECYCLE_LEASE_INVALID ? "lease_invalid" :
            result == RT_SERVICE_UID_V1_LIFECYCLE_SECRET_INVALID ? "secret_channel_invalid" :
            result == RT_SERVICE_UID_V1_LIFECYCLE_WORKSPACE_GRANT_INVALID ? "workspace_grant_invalid" :
            result == RT_SERVICE_UID_V1_LIFECYCLE_WORKLOAD_INVALID ? "workload_invalid" :
            result == RT_SERVICE_UID_V1_LIFECYCLE_CLEANUP_UNCONFIRMED ? "cleanup_unconfirmed" :
            "internal_failure";
        send_operation_failure(peer, message, &request, error);
    } else {
        send_operation_success(peer, message, &request);
    }
}

static void accept_peer(xpc_connection_t peer) {
    if (RT_SERVICE_UID_V1_CLIENT_UID == UINT32_MAX ||
        xpc_connection_get_euid(peer) != (uid_t)RT_SERVICE_UID_V1_CLIENT_UID ||
        xpc_connection_get_asid(peer) == AU_DEFAUDITSID ||
        xpc_connection_get_asid(peer) == AU_ASSIGN_ASID) {
        xpc_connection_cancel(peer);
        return;
    }
    xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) handle_message(peer, event);
    });
    xpc_connection_resume(peer);
}

int main(void) {
    if (geteuid() != 0U || RT_SERVICE_UID_V1_EXECUTION_UID == 0U ||
        RT_SERVICE_UID_V1_CLIENT_UID == UINT32_MAX ||
        RT_SERVICE_UID_V1_ACCEPTED_PEER_REQUIREMENT[0] == '\0') return 77;
    uuid_t id;
    uuid_generate_random(id);
    uuid_unparse_lower(id, service_instance_id);
    rt_service_uid_v1_broker_init(&broker, (rt_service_uid_v1_broker_callbacks_t){0});
    xpc_connection_t listener = xpc_connection_create_mach_service(
        "com.roundtable.runtime.service-uid-v1", NULL,
        XPC_CONNECTION_MACH_SERVICE_LISTENER);
    if (listener == NULL) return 70;
    if (xpc_connection_set_peer_code_signing_requirement(listener, RT_SERVICE_UID_V1_ACCEPTED_PEER_REQUIREMENT) != 0) {
        xpc_release(listener); return 78;
    }
    xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_CONNECTION) accept_peer((xpc_connection_t)event);
    });
    xpc_connection_resume(listener);
    dispatch_main();
}
