// Read-only, bounded accessibility probe for Claude Desktop. Never exports text,
// titles, URLs, element values, account IDs or conversation contents.
#include <ApplicationServices/ApplicationServices.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double monotonic(void) {
  struct timespec now;
  (void)clock_gettime(CLOCK_MONOTONIC, &now);
  return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}
static bool text_attribute(AXUIElementRef element, CFStringRef name, char *out, size_t size) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || value == NULL) return false;
  bool valid = CFGetTypeID(value) == CFStringGetTypeID() && CFStringGetCString((CFStringRef)value, out, (CFIndex)size, kCFStringEncodingUTF8);
  CFRelease(value);
  return valid;
}
static bool equals_any(const char *text, const char *const *allowed, size_t count) {
  for (size_t index = 0; index < count; index++) if (strcmp(text, allowed[index]) == 0) return true;
  return false;
}
static const char *const stop_labels[] = {
  "Stop response", "Stop generating", "Stop generation", "停止响应", "停止回應", "停止生成", "停止產生", "停止产生",
  "生成を停止", "応答を停止", "생성 중지", "응답 중지", "Остановить ответ", "Остановить генерацию", "Зупинити відповідь", "Зупинити генерацію",
  "Detener respuesta", "Detener generación", "Parar resposta", "Parar geração", "Arrêter la réponse", "Arrêter la génération",
  "Antwort stoppen", "Generierung stoppen", "Interrompi risposta", "Interrompi generazione", "Dừng phản hồi", "Dừng tạo",
  "जवाब रोकें", "उत्तर रोकें", "הפסק יצירה", "עצירת תגובה", "إيقاف الرد", "إيقاف التوليد"
};
static const char *const send_labels[] = {
  "Send message", "Send a message", "发送消息", "傳送訊息", "发送信息", "發送訊息", "メッセージを送信", "메시지 보내기",
  "Отправить сообщение", "Надіслати повідомлення", "Enviar mensaje", "Enviar mensagem", "Envoyer le message", "Envoyer un message",
  "Nachricht senden", "Invia messaggio", "Gửi tin nhắn", "संदेश भेजें", "שליחת הודעה", "إرسال الرسالة"
};
static const char *const composer_labels[] = {
  "Reply to Claude...", "Reply to Claude…", "Message Claude...", "Message Claude…", "回复 Claude...", "回复 Claude…", "回覆 Claude...", "回覆 Claude…",
  "How can I help you today?", "今天我能帮您什么？", "今天我能幫您什麼？", "向 Claude 发送消息", "向 Claude 發送訊息"
};
static const char *badge_plan(const char *text) {
  // Exact account-plan badges only. Marketing copy (upgrade, billing cancellation,
  // product/model names in chats) cannot establish the active subscription.
  static const struct { const char *text; const char *plan; } labels[] = {
    {"Free plan", "Free"}, {"Pro plan", "Pro"}, {"Max plan", "Max"}, {"Team plan", "Team"}, {"Enterprise plan", "Enterprise"},
    {"Free 套餐", "Free"}, {"Pro 套餐", "Pro"}, {"Max 套餐", "Max"}, {"Free 计划", "Free"}, {"Pro 计划", "Pro"}, {"Max 计划", "Max"},
    {"Free 計劃", "Free"}, {"Pro 計劃", "Pro"}, {"Max 計劃", "Max"}, {"Free 方案", "Free"}, {"Pro 方案", "Pro"}, {"Max 方案", "Max"}
  };
  for (size_t index = 0; index < sizeof(labels) / sizeof(labels[0]); index++) if (strcmp(text, labels[index].text) == 0) return labels[index].plan;
  return NULL;
}
struct observation { bool stop; bool send; bool composer; bool complete; const char *plan; size_t visited; double deadline; };
static void inspect(AXUIElementRef element, unsigned int depth, bool in_account, struct observation *state) {
  if (depth > 28 || state->visited++ >= 1600 || monotonic() >= state->deadline) { state->complete = false; return; }
  char role[64] = "", label[2048] = "", identifier[256] = "";
  (void)text_attribute(element, kAXRoleAttribute, role, sizeof(role));
  (void)text_attribute(element, CFSTR("AXIdentifier"), identifier, sizeof(identifier));
  // Conversation message trees are irrelevant to the composer state and can
  // contain thousands of elements. Skip those subtrees before visiting children.
  if (strcmp(role, "AXGroup") == 0 || strcmp(role, "AXList") == 0) {
    (void)text_attribute(element, kAXDescriptionAttribute, label, sizeof(label));
    if (!label[0]) (void)text_attribute(element, kAXTitleAttribute, label, sizeof(label));
    if (strcmp(label, "Conversation messages") == 0 || strcmp(label, "Chat messages") == 0
        || strcmp(label, "对话消息") == 0 || strcmp(label, "對話訊息") == 0 || strcmp(identifier, "chat-messages") == 0) return;
    label[0] = '\0';
  }
  bool account = in_account || strcmp(identifier, "user-menu-button") == 0 || strcmp(identifier, "account-menu-button") == 0;
  bool button = strcmp(role, "AXButton") == 0 || strcmp(role, "AXPopUpButton") == 0;
  if (button) {
    bool has_label = text_attribute(element, kAXTitleAttribute, label, sizeof(label));
    if (!has_label || !label[0]) (void)text_attribute(element, kAXDescriptionAttribute, label, sizeof(label));
    if (equals_any(label, stop_labels, sizeof(stop_labels) / sizeof(stop_labels[0]))) state->stop = true;
    if (equals_any(label, send_labels, sizeof(send_labels) / sizeof(send_labels[0]))) state->send = true;
    if (strcmp(identifier, "send-button") == 0 || strcmp(identifier, "chat-send-button") == 0) state->send = true;
    if (strcmp(identifier, "stop-response-button") == 0 || strcmp(identifier, "stop-generation-button") == 0) state->stop = true;
  } else if (strcmp(role, "AXTextArea") == 0) {
    (void)text_attribute(element, kAXDescriptionAttribute, label, sizeof(label));
    if (equals_any(label, composer_labels, sizeof(composer_labels) / sizeof(composer_labels[0]))
        || strcmp(identifier, "chat-input") == 0 || strcmp(identifier, "prompt-textarea") == 0) state->composer = true;
  } else if (account && strcmp(role, "AXStaticText") == 0) {
    // Only descendants of the account menu are eligible for a plan badge. Never
    // inspect the value of an editable text field or any conversation element.
    (void)text_attribute(element, kAXValueAttribute, label, sizeof(label));
    const char *plan = badge_plan(label); if (plan != NULL) state->plan = plan;
  }
  if (state->stop) return;
  CFTypeRef children = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) == kAXErrorSuccess
      && children != NULL && CFGetTypeID(children) == CFArrayGetTypeID()) {
    CFIndex count = CFArrayGetCount((CFArrayRef)children);
    for (CFIndex index = 0; index < count; index++) {
      if (monotonic() >= state->deadline || state->visited >= 1600) { state->complete = false; break; }
      CFTypeRef child = CFArrayGetValueAtIndex((CFArrayRef)children, index);
      if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) inspect((AXUIElementRef)child, depth + 1, account, state);
    }
  }
  if (children != NULL) CFRelease(children);
}
int main(int argc, char **argv) {
  bool request = argc == 2 && strcmp(argv[1], "--request-access") == 0;
  bool trusted;
  if (request) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt }; const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    trusted = AXIsProcessTrustedWithOptions(options); CFRelease(options);
  } else trusted = AXIsProcessTrusted();
  if (!trusted || request) {
    (void)printf("{\"trusted\":%s,\"activity\":\"unknown\",\"plan\":null,\"complete\":false}\n", trusted ? "true" : "false"); return 0;
  }
  char *end = NULL; long number = argc == 2 ? strtol(argv[1], &end, 10) : 0;
  char process_name[64] = "";
  if (number < 1 || number > 2147483647 || end == NULL || *end != '\0'
      || proc_name((int)number, process_name, sizeof(process_name)) <= 0 || strcmp(process_name, "Claude") != 0) {
    (void)printf("{\"trusted\":true,\"activity\":\"unknown\",\"plan\":null,\"complete\":false}\n"); return 0;
  }
  AXUIElementRef app = AXUIElementCreateApplication((pid_t)number);
  (void)AXUIElementSetMessagingTimeout(app, 0.05f);
  struct observation state = { false, false, false, true, NULL, 0, monotonic() + 0.75 };
  inspect(app, 0, false, &state); CFRelease(app);
  const char *activity = state.stop ? "running"
    : state.complete && (state.send || state.composer) && !state.stop ? "idle" : "unknown";
  (void)printf("{\"trusted\":true,\"activity\":\"%s\",\"plan\":", activity);
  if (state.plan != NULL && (state.send || state.composer)) (void)printf("\"%s\"", state.plan); else (void)printf("null");
  (void)printf(",\"complete\":%s}\n", state.complete ? "true" : "false");
  return 0;
}
