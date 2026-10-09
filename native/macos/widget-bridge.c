#define NAPI_VERSION 8
#include <node_api.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#define AIWATCH_MAX_SNAPSHOT_BYTES (64u * 1024u)

extern int32_t aiwatch_widget_publish(const uint8_t *bytes, size_t length, int32_t reload);
extern int32_t aiwatch_widget_clear(void);
extern int32_t aiwatch_widget_available(void);

static napi_value boolean_result(napi_env env, bool value) {
  napi_value result = NULL;
  if (napi_get_boolean(env, value, &result) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value publish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {NULL, NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return boolean_result(env, false);
  }

  napi_valuetype json_type;
  napi_valuetype reload_type;
  if (napi_typeof(env, argv[0], &json_type) != napi_ok || json_type != napi_string ||
      napi_typeof(env, argv[1], &reload_type) != napi_ok || reload_type != napi_boolean) {
    return boolean_result(env, false);
  }

  size_t byte_length = 0;
  bool reload = false;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &byte_length) != napi_ok ||
      byte_length > AIWATCH_MAX_SNAPSHOT_BYTES ||
      napi_get_value_bool(env, argv[1], &reload) != napi_ok) {
    return boolean_result(env, false);
  }

  char *json = malloc(byte_length + 1);
  if (json == NULL) {
    return boolean_result(env, false);
  }

  size_t copied = 0;
  napi_status status = napi_get_value_string_utf8(env, argv[0], json, byte_length + 1, &copied);
  bool success = status == napi_ok && copied == byte_length &&
                 aiwatch_widget_publish((const uint8_t *)json, copied, reload ? 1 : 0) != 0;
  free(json);
  return boolean_result(env, success);
}

static napi_value clear(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0) {
    return boolean_result(env, false);
  }
  return boolean_result(env, aiwatch_widget_clear() != 0);
}

static napi_value available(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0) {
    return boolean_result(env, false);
  }
  return boolean_result(env, aiwatch_widget_available() != 0);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"publish", NULL, publish, NULL, NULL, NULL, napi_default, NULL},
      {"clear", NULL, clear, NULL, NULL, NULL, napi_default, NULL},
      {"available", NULL, available, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
