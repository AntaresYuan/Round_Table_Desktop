#ifndef ROUNDTABLE_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_CONFIG_H
#define ROUNDTABLE_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_CONFIG_H

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "protocol.h"

#ifndef RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT ""
#endif

#ifndef RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE ""
#endif

#ifndef RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD 1
#endif

#ifndef RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD 0
#endif

#define RT_SERVICE_UID_BOOTSTRAP_PROBE_CDHASH_HEX_BYTES 40U

static inline bool rt_service_uid_bootstrap_probe_cdhash_valid(
    const char *cdhash
) {
    if (cdhash == NULL ||
        strnlen(cdhash, RT_SERVICE_UID_BOOTSTRAP_PROBE_CDHASH_HEX_BYTES + 1U) !=
            RT_SERVICE_UID_BOOTSTRAP_PROBE_CDHASH_HEX_BYTES) {
        return false;
    }
    for (size_t index = 0U;
         index < RT_SERVICE_UID_BOOTSTRAP_PROBE_CDHASH_HEX_BYTES;
         index += 1U) {
        const char value = cdhash[index];
        if (!((value >= '0' && value <= '9') ||
              (value >= 'a' && value <= 'f') ||
              (value >= 'A' && value <= 'F'))) {
            return false;
        }
    }
    return true;
}

static inline bool rt_service_uid_bootstrap_probe_pinned_requirement(
    const char *identifier,
    const char *cdhash,
    char *output,
    size_t output_size
) {
    if (identifier == NULL || output == NULL || output_size == 0U ||
        !rt_service_uid_bootstrap_probe_cdhash_valid(cdhash)) {
        return false;
    }
    const int written = snprintf(
        output,
        output_size,
        "identifier \"%s\" and cdhash H\"%s\"",
        identifier,
        cdhash
    );
    return written > 0 && (size_t)written < output_size;
}

static inline bool rt_service_uid_bootstrap_probe_security_config_valid(void) {
    const size_t requirement_length = strnlen(
        RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT,
        RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUIREMENT_BYTES + 1U
    );
    if (requirement_length == 0U ||
        requirement_length > RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUIREMENT_BYTES) {
        return false;
    }

    if (RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD == 1) {
        return strcmp(
            RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
            "production"
        ) == 0;
    }
    if (RT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD == 0) {
        return strcmp(
                   RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
                   "development-adhoc"
               ) == 0 ||
            strcmp(
                RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
                "development-signed"
            ) == 0 ||
            strcmp(
                RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE,
                "development-adhoc-pinned"
            ) == 0;
    }
    return false;
}

#endif
