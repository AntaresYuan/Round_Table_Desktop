#include "protocol.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <xpc/xpc.h>

static bool rt_expect(bool condition, const char *name) {
    if (!condition) {
        fprintf(
            stderr,
            "service-uid bootstrap-probe-v0 self-test failed: %s\n",
            name
        );
        return false;
    }
    return true;
}

static xpc_object_t rt_request(
    const char *request_id,
    rt_service_uid_bootstrap_probe_operation_t operation
) {
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0U);
    if (!rt_service_uid_bootstrap_probe_populate_request(
            request,
            request_id,
            operation
        )) {
        xpc_release(request);
        return NULL;
    }
    return request;
}

static xpc_object_t rt_success(
    const rt_service_uid_bootstrap_probe_request_t *request,
    const char *security_mode
) {
    xpc_object_t response = xpc_dictionary_create(NULL, NULL, 0U);
    if (!rt_service_uid_bootstrap_probe_populate_success(
            response,
            request,
            security_mode,
            UINT64_C(501),
            UINT64_C(42)
        )) {
        xpc_release(response);
        return NULL;
    }
    return response;
}

static bool rt_test_requests(void) {
    bool ok = true;
    rt_service_uid_bootstrap_probe_request_t parsed = {0};

    xpc_object_t ping = rt_request(
        "request-1",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
    );
    ok &= rt_expect(ping != NULL, "construct ping");
    ok &= rt_expect(
        ping != NULL &&
            rt_service_uid_bootstrap_probe_parse_request(ping, &parsed) &&
            parsed.operation == RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING &&
            strcmp(parsed.request_id, "request-1") == 0,
        "parse exact ping"
    );
    if (ping != NULL) {
        xpc_release(ping);
    }

    xpc_object_t status = rt_request(
        "request_2.status",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS
    );
    ok &= rt_expect(
        status != NULL &&
            rt_service_uid_bootstrap_probe_parse_request(status, &parsed) &&
            parsed.operation == RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS,
        "parse exact status"
    );
    if (status != NULL) {
        xpc_dictionary_set_bool(status, "unexpected", true);
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_request(status, &parsed),
            "reject extra request key"
        );
        xpc_release(status);
    }

    xpc_object_t missing = rt_request(
        "missing",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
    );
    if (missing != NULL) {
        xpc_dictionary_set_value(missing, "operation", NULL);
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_request(missing, &parsed),
            "reject missing request key"
        );
        xpc_release(missing);
    } else {
        ok &= rt_expect(false, "construct missing-key fixture");
    }

    xpc_object_t wrong_type = rt_request(
        "wrong-type",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
    );
    if (wrong_type != NULL) {
        xpc_dictionary_set_string(wrong_type, "probe_version", "0");
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_request(wrong_type, &parsed),
            "reject request type confusion"
        );
        xpc_release(wrong_type);
    } else {
        ok &= rt_expect(false, "construct type fixture");
    }

    xpc_object_t wrong_version = rt_request(
        "wrong-version",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
    );
    if (wrong_version != NULL) {
        xpc_dictionary_set_uint64(wrong_version, "probe_version", 1U);
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_request(wrong_version, &parsed),
            "reject protocol downgrade or upgrade"
        );
        xpc_release(wrong_version);
    } else {
        ok &= rt_expect(false, "construct version fixture");
    }

    xpc_object_t unknown_operation = rt_request(
        "unknown-operation",
        RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
    );
    if (unknown_operation != NULL) {
        xpc_dictionary_set_string(unknown_operation, "operation", "execute");
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_request(
                unknown_operation,
                &parsed
            ),
            "reject command-like operation"
        );
        xpc_release(unknown_operation);
    } else {
        ok &= rt_expect(false, "construct operation fixture");
    }

    xpc_object_t lifecycle_v1 = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(lifecycle_v1, "backend", "macos-service-uid-v1");
    xpc_dictionary_set_uint64(lifecycle_v1, "protocolVersion", 1U);
    xpc_dictionary_set_string(lifecycle_v1, "requestId", "request-v1");
    xpc_dictionary_set_string(lifecycle_v1, "type", "status");
    ok &= rt_expect(
        !rt_service_uid_bootstrap_probe_parse_request(lifecycle_v1, &parsed),
        "reject macos-service-uid-v1 lifecycle request"
    );
    xpc_release(lifecycle_v1);

    char overlong[RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES + 2U];
    memset(overlong, 'a', sizeof(overlong));
    overlong[sizeof(overlong) - 1U] = '\0';
    xpc_object_t invalid_id = xpc_dictionary_create(NULL, NULL, 0U);
    ok &= rt_expect(
        !rt_service_uid_bootstrap_probe_populate_request(
            invalid_id,
            overlong,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
        ),
        "reject oversized request id"
    );
    ok &= rt_expect(
        !rt_service_uid_bootstrap_probe_populate_request(
            invalid_id,
            "bad/id",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING
        ),
        "reject request id metacharacters"
    );
    xpc_release(invalid_id);

    xpc_object_t unsafe = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(unsafe, "request_id", "bad/id");
    ok &= rt_expect(
        strcmp(
            rt_service_uid_bootstrap_probe_safe_request_id(unsafe),
            "invalid"
        ) == 0,
        "sanitize untrusted error correlation id"
    );
    xpc_release(unsafe);
    return ok;
}

static bool rt_test_success_responses(void) {
    bool ok = true;
    const rt_service_uid_bootstrap_probe_request_t request = {
        .request_id = "request-3",
        .operation = RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS,
    };
    rt_service_uid_bootstrap_probe_success_t parsed = {0};

    xpc_object_t response = rt_success(&request, "development-adhoc");
    ok &= rt_expect(
        response != NULL && rt_service_uid_bootstrap_probe_parse_success(
            response,
            &request,
            "development-adhoc",
            &parsed
        ) && parsed.peer_euid == UINT64_C(501) &&
            parsed.peer_audit_session == UINT64_C(42),
        "parse exact success"
    );
    xpc_object_t pinned = rt_success(&request, "development-adhoc-pinned");
    ok &= rt_expect(
        pinned != NULL && rt_service_uid_bootstrap_probe_parse_success(
            pinned,
            &request,
            "development-adhoc-pinned",
            &parsed
        ),
        "parse pinned development success"
    );
    if (pinned != NULL) xpc_release(pinned);
    if (response != NULL) {
        xpc_dictionary_set_bool(response, "unexpected", true);
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_success(
                response,
                &request,
                "development-adhoc",
                &parsed
            ),
            "reject extra response key"
        );
        xpc_release(response);
    }

    xpc_object_t wrong_capability = rt_success(
        &request,
        "development-adhoc"
    );
    if (wrong_capability != NULL) {
        xpc_dictionary_set_string(wrong_capability, "capability", "ping");
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_success(
                wrong_capability,
                &request,
                "development-adhoc",
                &parsed
            ),
            "reject mismatched capability"
        );
        xpc_release(wrong_capability);
    } else {
        ok &= rt_expect(false, "construct capability fixture");
    }

    xpc_object_t wrong_type = rt_success(&request, "production");
    if (wrong_type != NULL) {
        xpc_dictionary_set_string(wrong_type, "peer_euid", "501");
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_success(
                wrong_type,
                &request,
                "production",
                &parsed
            ),
            "reject response type confusion"
        );
        xpc_release(wrong_type);
    } else {
        ok &= rt_expect(false, "construct success type fixture");
    }

    xpc_object_t wrong_mode = rt_success(&request, "production");
    if (wrong_mode != NULL) {
        ok &= rt_expect(
            !rt_service_uid_bootstrap_probe_parse_success(
                wrong_mode,
                &request,
                "development-adhoc",
                &parsed
            ),
            "bind response to security mode"
        );
        xpc_release(wrong_mode);
    } else {
        ok &= rt_expect(false, "construct mode fixture");
    }
    return ok;
}

static bool rt_test_error_responses(void) {
    bool ok = true;
    const char *parsed_code = NULL;
    xpc_object_t response = xpc_dictionary_create(NULL, NULL, 0U);
    ok &= rt_expect(
        rt_service_uid_bootstrap_probe_populate_error(
            response,
            "request-4",
            RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INVALID_REQUEST
        ) && rt_service_uid_bootstrap_probe_parse_error(
            response,
            "request-4",
            &parsed_code
        ) && strcmp(
            parsed_code,
            RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INVALID_REQUEST
        ) == 0,
        "parse exact error"
    );
    xpc_dictionary_set_bool(response, "debug", true);
    ok &= rt_expect(
        !rt_service_uid_bootstrap_probe_parse_error(
            response,
            "request-4",
            &parsed_code
        ),
        "reject diagnostic data in error"
    );
    xpc_release(response);

    xpc_object_t arbitrary = xpc_dictionary_create(NULL, NULL, 0U);
    ok &= rt_expect(
        !rt_service_uid_bootstrap_probe_populate_error(
            arbitrary,
            "request-5",
            "details"
        ),
        "reject arbitrary error code"
    );
    xpc_release(arbitrary);
    return ok;
}

int main(void) {
    if (!rt_test_requests() || !rt_test_success_responses() ||
        !rt_test_error_responses()) {
        return 1;
    }
    puts("service-uid-bootstrap-probe-v0 self-test ok (not a Phase 4 gate)");
    return 0;
}
