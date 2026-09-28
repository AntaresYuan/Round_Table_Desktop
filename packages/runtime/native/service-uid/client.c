#include "protocol.h"
#include "security_config.h"

#include <bsm/audit.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>

#define RT_SERVICE_UID_BOOTSTRAP_PROBE_BROKER_IDENTIFIER \
    "com.roundtable.desktop.service-uid-bootstrap-probe-v0-broker"

#if defined(RT_SERVICE_UID_BOOTSTRAP_PROBE_WRONG_FIXTURE)
__attribute__((used)) static const char rt_wrong_cdhash_fixture_marker[] =
    "roundtable-service-uid-wrong-cdhash-fixture-v1";
#endif

static rt_service_uid_bootstrap_probe_operation_t rt_parse_operation(
    const char *value
) {
    if (strcmp(value, "ping") == 0) {
        return RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING;
    }
    if (strcmp(value, "status") == 0) {
        return RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS;
    }
    return RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_INVALID;
}

static void rt_ignore_connection_event(xpc_object_t event) {
    (void)event;
}

int main(int argc, char **argv) {
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD == 1
    if (argc != 5 || strcmp(argv[3], "--accepted-broker-cdhash") != 0) {
        fputs(
            "usage: service-uid-bootstrap-probe-v0-client "
            "ping|status REQUEST_ID --accepted-broker-cdhash CDHASH\n",
            stderr
        );
        return 64;
    }
#else
    if (argc != 3) {
        fputs(
            "usage: service-uid-bootstrap-probe-v0-client "
            "ping|status REQUEST_ID\n",
            stderr
        );
        return 64;
    }
#endif

    const char *accepted_peer_requirement =
        RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT;
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD == 1
    char pinned_peer_requirement[
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUIREMENT_BYTES + 1U
    ] = {0};
    if (!rt_service_uid_bootstrap_probe_pinned_requirement(
            RT_SERVICE_UID_BOOTSTRAP_PROBE_BROKER_IDENTIFIER,
            argv[4],
            pinned_peer_requirement,
            sizeof(pinned_peer_requirement)
        )) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: invalid broker cdhash\n",
            stderr
        );
        return 64;
    }
    accepted_peer_requirement = pinned_peer_requirement;
#endif

    const rt_service_uid_bootstrap_probe_operation_t operation =
        rt_parse_operation(argv[1]);
    xpc_object_t request_message = xpc_dictionary_create(NULL, NULL, 0U);
    if (operation == RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_INVALID ||
        !rt_service_uid_bootstrap_probe_populate_request(
            request_message,
            argv[2],
            operation
        )) {
        fputs("service-uid-bootstrap-probe-v0-client: invalid probe request\n", stderr);
        xpc_release(request_message);
        return 64;
    }
    if (!rt_service_uid_bootstrap_probe_security_config_valid()) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: invalid signing "
            "requirement configuration\n",
            stderr
        );
        xpc_release(request_message);
        return 78;
    }

    xpc_connection_t connection = xpc_connection_create_mach_service(
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MACH_SERVICE,
        NULL,
        XPC_CONNECTION_MACH_SERVICE_PRIVILEGED
    );
    if (connection == NULL) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: connection creation failed\n",
            stderr
        );
        xpc_release(request_message);
        return 70;
    }

    const int requirement_status =
        xpc_connection_set_peer_code_signing_requirement(
            connection,
            accepted_peer_requirement
        );
    if (requirement_status != 0) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: peer requirement rejected\n",
            stderr
        );
        xpc_release(connection);
        xpc_release(request_message);
        return 78;
    }

    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        rt_ignore_connection_event(event);
    });
    xpc_connection_resume(connection);

    xpc_object_t response = xpc_connection_send_message_with_reply_sync(
        connection,
        request_message
    );
    xpc_release(request_message);
    if (response == NULL || xpc_get_type(response) != XPC_TYPE_DICTIONARY) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: broker unavailable or rejected\n",
            stderr
        );
        if (response != NULL) {
            xpc_release(response);
        }
        xpc_connection_cancel(connection);
        xpc_release(connection);
        return 69;
    }

    const uid_t broker_euid = xpc_connection_get_euid(connection);
    const au_asid_t broker_asid = xpc_connection_get_asid(connection);
    /* A system LaunchDaemon normally has AU_DEFAUDITSID (0), which is valid. */
    if (broker_euid != 0U || broker_asid == AU_ASSIGN_ASID) {
        fputs(
            "service-uid-bootstrap-probe-v0-client: broker audit identity rejected\n",
            stderr
        );
        xpc_release(response);
        xpc_connection_cancel(connection);
        xpc_release(connection);
        return 77;
    }

    rt_service_uid_bootstrap_probe_request_t parsed_request = {0};
    const size_t request_id_length = strlen(argv[2]);
    memcpy(parsed_request.request_id, argv[2], request_id_length + 1U);
    parsed_request.operation = operation;

    rt_service_uid_bootstrap_probe_success_t success = {0};
    const char *error_code = NULL;
    int exit_code = 0;
    if (rt_service_uid_bootstrap_probe_parse_success(
            response,
            &parsed_request,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
            &success
        )) {
        if (success.peer_euid != (uint64_t)geteuid()) {
            fputs(
                "service-uid-bootstrap-probe-v0-client: broker bound the wrong caller\n",
                stderr
            );
            exit_code = 77;
        } else {
            printf(
                "service-uid-bootstrap-probe-v0 ok %s %s "
                "(not a Phase 4 gate)\n",
                rt_service_uid_bootstrap_probe_operation_name(operation),
                RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE
            );
        }
    } else if (rt_service_uid_bootstrap_probe_parse_error(
                   response,
                   argv[2],
                   &error_code
               )) {
        (void)error_code;
        fputs(
            "service-uid-bootstrap-probe-v0-client: broker rejected request\n",
            stderr
        );
        exit_code = 77;
    } else {
        fputs(
            "service-uid-bootstrap-probe-v0-client: malformed broker response\n",
            stderr
        );
        exit_code = 76;
    }

    xpc_release(response);
    xpc_connection_cancel(connection);
    xpc_release(connection);
    return exit_code;
}
