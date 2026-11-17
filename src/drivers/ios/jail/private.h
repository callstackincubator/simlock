// why: Swift reaches C through a header, and none of these is in an SDK header: they are private
// libsystem and libsandbox interfaces, so a macOS or Xcode release can change them.
#include <stddef.h>
#include <sys/types.h>

// why: the real function is variadic, which Swift cannot call; the jail only asks "is this process
// sandboxed?", the form that takes no further argument. The library asks it of itself, and
// `simlock-jail check` of the simulator's processes.
int sandbox_check(pid_t pid, const char *operation, int type);
// why: only their addresses are used, as interposing targets, so the arguments are left out.
int sandbox_check_by_audit_token(void);
int sandbox_check_by_uniqueid(void);

// why: the layout the "Sandbox" policy's call 0 reads; found by disassembling macOS 26.6's
// sandbox_apply_container, since nothing documents it.
struct simlock_jail_profile {
  const unsigned char *data;
  size_t size;
  char *container;
  size_t container_len;
};
int __sandbox_ms(const char *policy, int call, void *arg);
void _sandbox_enter_notify_libxpc(void);

// why: libsandbox's own result type; `simlock-jail compile` reads `data` and `size` only. The
// parameters are what a profile reads with `(param "NAME")`.
struct sandbox_profile {
  char *builtin;
  unsigned char *data;
  size_t size;
};
typedef struct sandbox_params sandbox_params_t;
sandbox_params_t *sandbox_create_params(void);
int sandbox_set_param(sandbox_params_t *params, const char *name, const char *value);
struct sandbox_profile *sandbox_compile_file(const char *path, sandbox_params_t *params, char **error);
