#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int executable_path(char output[PATH_MAX]) {
  uint32_t size = PATH_MAX;
  char unresolved[PATH_MAX] = {0};
  if (_NSGetExecutablePath(unresolved, &size) != 0 || !realpath(unresolved, output)) {
    fprintf(stderr, "Hitchhiker could not resolve its application path\n");
    return 0;
  }
  return 1;
}

static int bundle_path(const char *executable, const char *relative, char output[PATH_MAX]) {
  const char suffix[] = "/Contents/MacOS/Hitchhiker";
  const size_t executable_length = strlen(executable);
  const size_t suffix_length = sizeof(suffix) - 1;
  if (executable_length <= suffix_length ||
      strcmp(executable + executable_length - suffix_length, suffix) != 0) {
    fprintf(stderr, "Hitchhiker executable is outside its expected application bundle\n");
    return 0;
  }
  const int written = snprintf(output, PATH_MAX, "%.*s/Contents/%s",
                               (int)(executable_length - suffix_length), executable, relative);
  if (written < 0 || written >= PATH_MAX) {
    fprintf(stderr, "Hitchhiker application path is too long\n");
    return 0;
  }
  return 1;
}

static int require_path(const char *name, const char *path, int mode) {
  if (access(path, mode) == 0) return 1;
  fprintf(stderr, "Hitchhiker bundle is missing %s at %s\n", name, path);
  return 0;
}

int main(int argc, char *argv[]) {
  char executable[PATH_MAX] = {0};
  char node[PATH_MAX] = {0};
  char controller[PATH_MAX] = {0};
  char engine[PATH_MAX] = {0};
  char plugin_host[PATH_MAX] = {0};
  if (!executable_path(executable) ||
      !bundle_path(executable, "Helpers/node", node) ||
      !bundle_path(executable, "Resources/controller/dist/main.js", controller) ||
      !bundle_path(executable, "MacOS/hitchhiker-probe", engine) ||
      !bundle_path(executable,
                   "Helpers/PluginHost.app/Contents/MacOS/plugin-host", plugin_host)) {
    return 70;
  }

  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    printf("Hitchhiker developer bundle\n"
           "Usage: Hitchhiker [--profile-root=/absolute/path] [--safe-mode] "
           "[--plugin=/absolute/path] [--mcp] [--cdp]\n");
    return 0;
  }

  if (!require_path("Node 24.19.0", node, X_OK) ||
      !require_path("browser controller", controller, R_OK) ||
      !require_path("CEF engine", engine, X_OK) ||
      !require_path("PluginHost", plugin_host, X_OK)) {
    return 66;
  }
  if (setenv("HITCHHIKER_NATIVE_BINARY", engine, 1) != 0 ||
      setenv("HITCHHIKER_PLUGIN_HOST", plugin_host, 1) != 0) {
    fprintf(stderr, "Hitchhiker could not configure its bundled helpers\n");
    return 70;
  }

  char **child_arguments = calloc((size_t)argc + 2, sizeof(char *));
  if (!child_arguments) {
    fprintf(stderr, "Hitchhiker could not allocate launcher arguments\n");
    return 71;
  }
  child_arguments[0] = node;
  child_arguments[1] = controller;
  for (int index = 1; index < argc; index++) child_arguments[index + 1] = argv[index];
  child_arguments[argc + 1] = NULL;
  execv(node, child_arguments);
  fprintf(stderr, "Hitchhiker could not start bundled Node: %s\n", strerror(errno));
  free(child_arguments);
  return 70;
}
