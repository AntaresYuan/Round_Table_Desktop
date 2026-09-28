#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>

enum {
    PROBE_BUFFER_SIZE = 1024 * 1024,
    EXIT_DENIED = 7,
    EXIT_PROBE_FAILED = 8,
    EXIT_MARKER_MISSING = 9
};

static int buffer_contains(
    const unsigned char *buffer,
    size_t buffer_size,
    const unsigned char *needle,
    size_t needle_size
) {
    if (needle_size == 0 || needle_size > buffer_size) {
        return 0;
    }
    for (size_t offset = 0; offset <= buffer_size - needle_size; offset += 1) {
        if (memcmp(buffer + offset, needle, needle_size) == 0) {
            return 1;
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fputs("invalid-arguments\n", stderr);
        return EXIT_PROBE_FAILED;
    }

    char *end = NULL;
    errno = 0;
    const long parsed_pid = strtol(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || parsed_pid <= 0) {
        fputs("invalid-pid\n", stderr);
        return EXIT_PROBE_FAILED;
    }

    unsigned char *buffer = calloc(1, PROBE_BUFFER_SIZE);
    if (buffer == NULL) {
        fputs("allocation-failed\n", stderr);
        return EXIT_PROBE_FAILED;
    }

    int mib[] = { CTL_KERN, KERN_PROCARGS2, (int)parsed_pid };
    size_t buffer_size = PROBE_BUFFER_SIZE;
    if (sysctl(mib, 3, buffer, &buffer_size, NULL, 0) != 0) {
        const int saved_errno = errno;
        free(buffer);
        if (saved_errno == EPERM || saved_errno == EACCES) {
            fputs("denied\n", stdout);
            return EXIT_DENIED;
        }
        fprintf(stderr, "sysctl-failed:%d\n", saved_errno);
        return EXIT_PROBE_FAILED;
    }

    const unsigned char *marker = (const unsigned char *)argv[2];
    const size_t marker_size = strlen(argv[2]);
    if (!buffer_contains(buffer, buffer_size, marker, marker_size)) {
        free(buffer);
        fputs("marker-missing\n", stderr);
        return EXIT_MARKER_MISSING;
    }

    free(buffer);
    fputs("allowed\n", stdout);
    return 0;
}
