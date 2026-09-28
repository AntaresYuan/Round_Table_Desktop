#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int write_all(int fd, const void *buffer, size_t length) {
  const unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t written = write(fd, cursor, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static void daemon_main(const char *pid_path, int ready_fd) {
  struct sigaction ignored;
  memset(&ignored, 0, sizeof(ignored));
  ignored.sa_handler = SIG_IGN;
  sigemptyset(&ignored.sa_mask);
  if (sigaction(SIGTERM, &ignored, NULL) != 0
      || sigaction(SIGINT, &ignored, NULL) != 0
      || sigaction(SIGHUP, &ignored, NULL) != 0) {
    _exit(20);
  }

  int pid_fd = open(pid_path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (pid_fd < 0) _exit(21);
  char payload[96];
  int payload_length = snprintf(payload, sizeof(payload), "{\"daemon\":%d}\n", getpid());
  if (payload_length <= 0
      || (size_t)payload_length >= sizeof(payload)
      || write_all(pid_fd, payload, (size_t)payload_length) != 0
      || fsync(pid_fd) != 0
      || close(pid_fd) != 0) {
    _exit(22);
  }
  if (write_all(ready_fd, "1", 1) != 0) _exit(23);
  close(ready_fd);

  int null_fd = open("/dev/null", O_RDWR);
  if (null_fd >= 0) {
    (void)dup2(null_fd, STDIN_FILENO);
    (void)dup2(null_fd, STDOUT_FILENO);
    (void)dup2(null_fd, STDERR_FILENO);
    if (null_fd > STDERR_FILENO) close(null_fd);
  }
  (void)chdir("/");
  for (;;) pause();
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] != '/') return 2;
  int ready_pipe[2];
  if (pipe(ready_pipe) != 0) return 3;
  (void)fcntl(ready_pipe[0], F_SETFD, FD_CLOEXEC);
  (void)fcntl(ready_pipe[1], F_SETFD, FD_CLOEXEC);

  pid_t first = fork();
  if (first < 0) return 4;
  if (first == 0) {
    close(ready_pipe[0]);
    if (setsid() < 0) _exit(10);
    pid_t daemon = fork();
    if (daemon < 0) _exit(11);
    if (daemon > 0) _exit(0);
    daemon_main(argv[1], ready_pipe[1]);
  }

  close(ready_pipe[1]);
  char ready = 0;
  ssize_t read_result;
  do {
    read_result = read(ready_pipe[0], &ready, 1);
  } while (read_result < 0 && errno == EINTR);
  close(ready_pipe[0]);
  int status = 0;
  while (waitpid(first, &status, 0) < 0) {
    if (errno != EINTR) return 5;
  }
  return read_result == 1
    && ready == '1'
    && WIFEXITED(status)
    && WEXITSTATUS(status) == 0
    ? 0
    : 6;
}
