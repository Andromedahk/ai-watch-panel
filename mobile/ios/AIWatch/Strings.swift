import Foundation

private var chinese: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }
private func localized(_ zh: String, _ en: String) -> String { chinese ? zh : en }
func requestTitle(_ key: String) -> String {
    switch key {
    case "codex.input": return localized("Codex · 待回答", "Codex · Answer requested")
    case "codex.commandApproval": return localized("Codex · 命令授权", "Codex · Command approval")
    case "codex.fileApproval": return localized("Codex · 文件修改授权", "Codex · File change approval")
    default: return localized("待处理请求", "Pending request")
    }
}
func requestLabel(_ key: String) -> String {
    let parts = key.split(separator: ".")
    guard parts.count == 2, let number = Int(parts[1]), (1...32).contains(number) else { return localized("请在电脑查看", "Review on desktop") }
    if parts[0] == "question" { return localized("第 \(number) 题", "Question \(number)") }
    if parts[0] == "option" { return localized("选项 \(number)", "Option \(number)") }
    return localized("请在电脑查看", "Review on desktop")
}
func requestDetail(_ key: String) -> String {
    if key == "input" { return localized("结构化问答", "Structured question") }
    if key == "fileChange" { return localized("文件修改", "File change") }
    let executables = ["git", "python", "python3", "node", "bash", "sh", "zsh", "npm", "npx", "pnpm", "yarn", "cargo", "go", "swift", "make", "cmake"]
    return executables.contains(key) ? localized("命令类别：", "Command category: ") + key : localized("请在电脑查看操作详情", "Review the operation on the desktop")
}
var requestNotice: String { localized("完整内容仅保留在电脑；手机仅显示类别和编号，请先在电脑确认上下文。", "Full content stays on the desktop. This phone shows only categories and numbers. Review the context on the desktop first.") }
func alertTitle(_ type: String) -> String {
    switch type {
    case "input": return localized("等待回答", "Answer requested")
    case "approval": return localized("等待授权", "Approval requested")
    case "low-quota": return localized("额度偏低", "Low quota")
    default: return localized("状态提醒", "Status alert")
    }
}

func L(_ text: String) -> String {
    if Locale.preferredLanguages.first?.hasPrefix("zh") == true { return text }
    return englishStrings[text] ?? text
}
private let englishStrings: [String: String] = [
    "实时关注未启用": "Live attention is disabled",
    "实时关注已关闭": "Live attention is disabled",
    "实时关注已开启": "Live attention is enabled",
    "实时关注已开启，等待待处理请求": "Live attention is enabled; waiting for requests",
    "系统已关闭实时活动": "Live Activities are disabled in system settings",
    "实时活动需要 iOS 16.1 或更新版本": "Live Activities require iOS 16.1 or later",
    "请先连接服务器": "Connect to the server first",
    "暂时无法创建实时活动，请检查系统设置": "Could not start a Live Activity; check system settings",
    "实时活动推送已登记": "Live Activity push updates registered",
    "实时活动已在本机开启，远程更新登记待重试": "Local Live Activity enabled; remote update registration will retry",
    "本机实时活动已结束，云端注销将在联网后重试": "Local activity ended; server cleanup will retry when connected",
    "请等待当前操作完成": "Wait for the current operation to finish",
    "无法安全保存连接，请检查应用签名。": "Cannot save the connection securely. Check the app signing.",
    "值守台": "Watch", "表盘": "Dial", "角色栏": "Party", "外观": "Appearance", "最紧额度": "Tightest quota", "暂无可用额度": "No quota available",
    "消息中心": "Message center", "未读": "Unread", "已读": "Read", "标记全部已读": "Mark all as read",
    "暂无提醒": "No alerts", "提醒已解除或需在电脑处理。": "This alert has resolved or requires the desktop.",
    "已解除": "Resolved", "新的提醒：": "New alert: ", "前台和返回 App 时会补收最近提醒；后台系统通知仍需推送服务。": "Recent alerts are recovered while active or when reopening the app. Background system notifications still require push services.",
    "HTTPS 服务器地址": "HTTPS server address",
    "关闭": "Close",
    "刷新": "Refresh",
    "刷新回执": "Refresh receipts",
    "助手状态": "Assistants",
    "原操作已锁定": "Original action locked",
    "原操作：": "Original action: ",
    "发送回答": "Send answer",
    "启用系统通知": "Enable notifications",
    "回答": "Answer",
    "填写回答": "Enter answer",
    "处理请求": "Review request",
    "实时连接": "Live connection",
    "已排队": "Queued",
    "已断开并注销此手机推送": "Disconnected; this phone has been revoked",
    "已过期": "Expired",
    "已送达桌面，等待确认": "Delivered; waiting for desktop confirmation",
    "待处理请求": "Pending requests",
    "待处理请求过多或内容过长，请在电脑查看完整列表": "Some requests exceed the sync budget. View the complete list on the desktop.",
    "手机配对凭据": "Mobile pairing credential",
    "手机访问令牌无效或已撤销。": "This phone credential is invalid or has been revoked.",
    "批准": "Approve",
    "批准仅对应当前显示的请求。提交后等待桌面回执。": "Approval applies only to this request. Wait for the desktop receipt after submitting.",
    "批准本次请求": "Approve this request",
    "拒绝": "Deny",
    "拒绝本次请求": "Deny this request",
    "推送已注册": "Push notifications registered",
    "推送注册失败，请检查签名与网络": "Push registration failed. Check signing and network.",
    "推送登记失败，将自动重试": "Push registration failed; retrying automatically",
    "操作回执": "Action receipts",
    "操作失败": "Failed",
    "操作状态：": "Action status: ",
    "敏感回答请在桌面提交。": "Submit sensitive answers on the desktop.",
    "断开后，此手机将停止接收推送。": "This phone will stop receiving notifications after disconnecting.",
    "断开并注销": "Disconnect and revoke",
    "断开并注销此手机": "Disconnect and revoke this phone",
    "无法同步，请检查网络与服务器。": "Cannot sync. Check your network and server.",
    "无法申请通知权限": "Cannot request notification permission",
    "无法连接服务器，请检查网络。": "Cannot connect. Check your network.",
    "最后同步：": "Last sync: ",
    "服务器返回了无法识别的数据。": "The server returned invalid data.",
    "未知": "Unknown",
    "来源：": "Source: ",
    "桌面在线": "Desktop online",
    "桌面已确认完成": "Desktop confirmed completion",
    "桌面离线 / 状态已过期": "Desktop offline / state expired",
    "桌面离线或请求已失效，请刷新。": "The desktop is offline or the request has expired. Refresh the state.",
    "正在注册推送": "Registering notifications",
    "正在重连 · 每 5 秒刷新": "Reconnecting · refresh every 5 seconds",
    "演示数据": "Sample data",
    "状态采样已过期，暂停手机操作": "Source sample is stale; actions are disabled",
    "确认": "Confirm ",
    "确认提交此操作？": "Submit this action?",
    "离线": "Offline",
    "空闲": "Idle",
    "等待回答": "Awaiting answer",
    "等待回答和授权": "Awaiting answer and approval",
    "等待处理": "Waiting",
    "等待授权": "Awaiting approval",
    "等待桌面上传状态": "Waiting for the desktop to upload state",
    "系统通知尚未开启": "System notifications are not enabled",
    "系统通知已关闭，可在系统设置中开启": "Notifications are disabled. Enable them in system Settings.",
    "该等待状态暂不支持手机操作，请在桌面处理。": "This waiting state cannot be handled on the phone. Use the desktop.",
    "请求已过期、已被处理或桌面离线。": "The request has expired, was handled, or the desktop is offline.",
    "请输入 HTTPS 服务器地址和有效配对凭据。": "Enter an HTTPS server address and a valid pairing credential.",
    "运行中": "Running",
    "连接": "Connect",
    "连接你的 AI Watch": "Connect your AI Watch",
    "通知与连接": "Notifications and connection",
    "通知尚未启用": "Notifications are not enabled",
    "重试原操作：": "Retry original action: ",
    "。网络结果尚未确认，不能改为其他操作。请先查看回执。": ". The network result is unconfirmed; you cannot change the action. Check the receipt first.",
    "FCM 尚未配置；状态查看与手机操作可用": "FCM is not configured. Status and actions are still available.",
    "取消": "Cancel",
    "同步数据无法识别": "The sync data could not be read",
    "实时连接中断，正在重连": "Live connection interrupted; reconnecting",
    "手机令牌无效或已撤销": "This phone credential is invalid or revoked",
    "打开 App 查看当前状态；操作前请确认请求仍有效。": "Open the app to review current state. Confirm the request is still valid.",
    "批准或回答仅对应当前请求，提交后等待桌面回执。": "Approval or answer applies only to this request. Wait for the desktop receipt.",
    "推送令牌获取失败，请检查 Google Play 服务": "Could not obtain a push token. Check Google Play services.",
    "推送登记失败，返回前台后重试": "Push registration failed. Reopen the app to retry.",
    "敏感回答请在桌面提交": "Submit sensitive answers on the desktop",
    "断开": "Disconnect",
    "无法连接服务器，请检查网络或返回数据": "Cannot connect. Check your network and server response.",
    "暂无可操作请求": "No actionable requests",
    "服务器拒绝操作，请刷新并确认请求仍有效": "The server rejected the action. Refresh and confirm it is still valid.",
    "桌面离线或请求已失效": "The desktop is offline or the request expired",
    "桌面离线或请求已失效，请刷新": "The desktop is offline or the request expired. Refresh the state.",
    "正在提交…": "Submitting…",
    "正在连接…": "Connecting…",
    "此手机将停止接收推送。注销失败时会保留连接，供重试。": "This phone will stop receiving notifications. If revocation fails, the connection is retained so you can retry.",
    "注销失败，请检查网络后重试": "Revocation failed. Check your network and retry.",
    "确认操作：": "Confirm action: ",
    "系统通知已关闭；可在系统设置中开启": "Notifications are disabled. Enable them in system Settings.",
    "该手机的独立令牌使用 Android Keystore 加密保存。配对凭据不会保存。": "This phone’s token is encrypted with Android Keystore. The pairing credential is not saved.",
    "请完整填写回答；敏感问题需在桌面处理。": "Complete every answer. Sensitive questions must be handled on the desktop.",
    "请求已处理或状态已变化，请刷新确认": "The request was handled or changed. Refresh to confirm.",
    "请求过于频繁，请稍后再试": "Too many requests. Try again later.",
    "请输入 HTTPS 根地址和有效配对凭据": "Enter an HTTPS origin and a valid pairing credential",
    "重试将保留原操作内容和操作编号。": "Retries retain the original content and operation ID.",
    "填写 HTTPS 服务器地址和管理员提供的配对凭据。": "Enter the HTTPS server address and the pairing credential supplied by the administrator.",
    "配对后仅保存此手机的独立令牌，可单独撤销。": "Pairing saves only this phone’s individual token, which can be revoked independently.",
    "待回答、授权和低额度提醒": "Answer, approval and low-quota alerts",
    "已选择：": "Selected: ",
    "连接状态：": "Connection: ",
    "活动任务：": "Active tasks: ",
    "缓存已过期": "Stale cache",
]
