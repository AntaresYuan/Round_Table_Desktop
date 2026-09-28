#include "protocol.h"
#include "security_config.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecBase.h>
#include <Security/SecCode.h>
#include <bsm/audit.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>

#define RT_SERVICE_UID_BOOTSTRAP_PROBE_CLIENT_IDENTIFIER \
    "com.roundtable.desktop.service-uid-bootstrap-probe-v0-client"

#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD == 0
static bool rt_parse_uid(const char *text, uid_t *uid) {
    if (text == NULL || uid == NULL || text[0] == '\0' || text[0] == '-') {
        return false;
    }

    errno = 0;
    char *end = NULL;
    const unsigned long parsed = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || parsed == 0UL ||
        parsed > (unsigned long)UINT32_MAX) {
        return false;
    }
    *uid = (uid_t)parsed;
    return true;
}
#endif

static bool rt_sender_audit_identity_valid(xpc_object_t message) {
    SecCodeRef sender = NULL;
    const OSStatus create_status = SecCodeCreateWithXPCMessage(
        message,
        kSecCSDefaultFlags,
        &sender
    );
    if (create_status != errSecSuccess || sender == NULL) {
        return false;
    }

    const OSStatus validity_status = SecCodeCheckValidity(
        sender,
        kSecCSDefaultFlags,
        NULL
    );
    CFRelease(sender);
    return validity_status == errSecSuccess;
}

static void rt_send_error(
    xpc_connection_t peer,
    xpc_object_t message,
    const char *error_code
) {
    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) {
        return;
    }
    if (rt_service_uid_bootstrap_probe_populate_error(
            response,
            rt_service_uid_bootstrap_probe_safe_request_id(message),
            error_code
        )) {
        xpc_connection_send_message(peer, response);
    }
    xpc_release(response);
}

static void rt_handle_message(
    xpc_connection_t peer,
    uid_t allowed_client_euid,
    uint64_t peer_audit_session,
    xpc_object_t message
) {
    if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) {
        return;
    }
    if (!rt_sender_audit_identity_valid(message)) {
        rt_send_error(
            peer,
            message,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_UNAUTHORIZED
        );
        xpc_connection_cancel(peer);
        return;
    }

    rt_service_uid_bootstrap_probe_request_t request = {0};
    if (!rt_service_uid_bootstrap_probe_parse_request(message, &request)) {
        rt_send_error(
            peer,
            message,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INVALID_REQUEST
        );
        return;
    }

    xpc_object_t response = xpc_dictionary_create_reply(message);
    if (response == NULL) {
        return;
    }
    if (!rt_service_uid_bootstrap_probe_populate_success(
            response,
            &request,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
            (uint64_t)allowed_client_euid,
            peer_audit_session
        )) {
        xpc_release(response);
        rt_send_error(
            peer,
            message,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INTERNAL
        );
        return;
    }
    xpc_connection_send_message(peer, response);
    xpc_release(response);
}

static void rt_accept_peer(xpc_connection_t peer, uid_t allowed_client_euid) {
    const uid_t peer_euid = xpc_connection_get_euid(peer);
    const au_asid_t peer_asid = xpc_connection_get_asid(peer);
    if (peer_euid != allowed_client_euid || peer_asid == AU_DEFAUDITSID ||
        peer_asid == AU_ASSIGN_ASID) {
        xpc_connection_cancel(peer);
        return;
    }

    const uint64_t peer_audit_session = (uint64_t)peer_asid;
    xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) {
            rt_handle_message(
                peer,
                allowed_client_euid,
                peer_audit_session,
                event
            );
        }
    });
    xpc_connection_resume(peer);
}

int main(int argc, char **argv) {
    uid_t allowed_client_euid = 0U;
    const char *accepted_peer_requirement =
        RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT;
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD == 1
    char pinned_peer_requirement[
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUIREMENT_BYTES + 1U
    ] = {0};
#endif
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD == 1
    (void)argv;
    if (argc != 1) {
        fputs(
            "usage: service-uid-bootstrap-probe-v0-broker\n"
            "production bootstrap probes do not accept identity via argv\n",
            stderr
        );
        return 64;
    }
#else
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD == 1
    if (argc != 5 || strcmp(argv[1], "--allowed-client-euid") != 0 ||
        strcmp(argv[3], "--accepted-client-cdhash") != 0) {
        fputs(
            "usage: service-uid-bootstrap-probe-v0-broker "
            "--allowed-client-euid UID --accepted-client-cdhash CDHASH\n",
            stderr
        );
        return 64;
    }
    if (!rt_service_uid_bootstrap_probe_pinned_requirement(
            RT_SERVICE_UID_BOOTSTRAP_PROBE_CLIENT_IDENTIFIER,
            argv[4],
            pinned_peer_requirement,
            sizeof(pinned_peer_requirement)
        )) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: invalid client cdhash\n",
            stderr
        );
        return 64;
    }
    accepted_peer_requirement = pinned_peer_requirement;
#else
    if (argc != 3 || strcmp(argv[1], "--allowed-client-euid") != 0) {
        fputs(
            "usage: service-uid-bootstrap-probe-v0-broker "
            "--allowed-client-euid UID\n",
            stderr
        );
        return 64;
    }
#endif

    if (!rt_parse_uid(argv[2], &allowed_client_euid)) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: invalid configured "
            "client identity\n",
            stderr
        );
        return 64;
    }
#endif
    if (geteuid() != 0U) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: privileged launch "
            "context required\n",
            stderr
        );
        return 77;
    }
#if RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD == 1
    fputs(
        "service-uid-bootstrap-probe-v0-broker: production installer-owned "
        "client identity is not implemented\n",
        stderr
    );
    return 78;
#endif
    if (!rt_service_uid_bootstrap_probe_security_config_valid()) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: invalid signing "
            "requirement configuration\n",
            stderr
        );
        return 78;
    }

    xpc_connection_t listener = xpc_connection_create_mach_service(
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MACH_SERVICE,
        NULL,
        XPC_CONNECTION_MACH_SERVICE_LISTENER
    );
    if (listener == NULL) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: listener creation failed\n",
            stderr
        );
        return 70;
    }

    const int requirement_status =
        xpc_connection_set_peer_code_signing_requirement(
            listener,
            accepted_peer_requirement
        );
    if (requirement_status != 0) {
        fputs(
            "service-uid-bootstrap-probe-v0-broker: peer requirement rejected\n",
            stderr
        );
        xpc_release(listener);
        return 78;
    }

    xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_CONNECTION) {
            rt_accept_peer((xpc_connection_t)event, allowed_client_euid);
        }
    });
    xpc_connection_resume(listener);
    dispatch_main();
}
