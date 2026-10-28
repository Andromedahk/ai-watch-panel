import ActivityKit

@available(iOS 16.1, *)
struct AIWatchAttentionAttributes: ActivityAttributes {
    typealias ContentState = AttentionState
    // Opaque installation identity used only to keep activities in the correct scope.
    let scope: String
}
