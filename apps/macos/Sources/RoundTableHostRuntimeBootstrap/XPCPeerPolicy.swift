import CryptoKit
import Foundation

enum XPCPeerPolicyError: Error {
    case peerAuditSessionInvalid
    case peerUserMismatch(expected: uid_t, actual: uid_t)
    case releaseIdentityInvalid
}

struct XPCPeerPolicy {
    let effectiveUserID: uid_t
    let requirement: String
    let identityDigest: String

    static func load() throws -> Self {
        // An App Sandbox process cannot reliably inspect the containing App's
        // executable with SecStaticCode.  Configure the peer requirement before
        // the connection is resumed instead.  Release binds the stable Apple
        // signing anchor, bundle identifier and Team ID.  Development is a
        // deliberately separate assurance profile: the private embedded-service
        // namespace plus this build entitlement is used only for the ad-hoc gate.
        #if DEBUG
        let requirement = "identifier \"com.roundtable.desktop\" and "
            + "entitlement[\"com.apple.security.get-task-allow\"] exists"
        #else
        guard let teamID = Bundle.main.object(
            forInfoDictionaryKey: "RoundTableExpectedTeamIdentifier") as? String,
              teamID.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else {
            throw XPCPeerPolicyError.releaseIdentityInvalid
        }
        let requirement = "anchor apple generic and identifier \"com.roundtable.desktop\" "
            + "and certificate leaf[subject.OU] = \"\(teamID)\""
        #endif
        let digest = SHA256.hash(data: Data(requirement.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return Self(effectiveUserID: geteuid(), requirement: requirement,
                    identityDigest: digest)
    }

    func verify(_ connection: NSXPCConnection) throws -> VerifiedAppPeer {
        guard connection.effectiveUserIdentifier == effectiveUserID else {
            throw XPCPeerPolicyError.peerUserMismatch(
                expected: effectiveUserID, actual: connection.effectiveUserIdentifier)
        }
        let peerAuditSessionID = connection.auditSessionIdentifier
        guard peerAuditSessionID != 0 else { throw XPCPeerPolicyError.peerAuditSessionInvalid }
        // This must happen before resume.  Foundation invalidates the connection
        // if a received message does not satisfy the configured requirement.
        connection.setCodeSigningRequirement(requirement)
        #if DEBUG
        let profile: VerifiedAppPeer.BuildProfile = .development
        #else
        let profile: VerifiedAppPeer.BuildProfile = .release
        #endif
        return try VerifiedAppPeer(effectiveUserID: effectiveUserID,
                                   auditSessionID: peerAuditSessionID,
                                   buildProfile: profile,
                                   codeIdentityDigest: identityDigest)
    }
}
