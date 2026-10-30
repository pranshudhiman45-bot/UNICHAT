# Workspace membership approval

The workspace creator is its owner and administrator. Creation provisions `general` and `random`. Names can repeat; generated slugs and invite codes are unique. Existing memberships are preserved.

An invite code identifies the workspace and submits a **join request**; it never grants access by itself. Applicants see “Waiting for administrator approval” on the Workspaces page. Workspace owners/admins receive a persistent Activity notification and can open **Workspaces → Manage access** to inspect the person's name, username, email, and verification status, then approve or reject. Approval makes the workspace available immediately; rejection keeps conversations inaccessible. Applicants can still create their own workspace.

Requests and member admission are updated atomically in the workspace document, including on standalone MongoDB. Duplicate submissions share a request, repeated approval repairs secondary user/channel membership, and conflicting decisions cannot both succeed. Only workspace owners/admins may review; ordinary members and applicants cannot approve themselves. Notifications are an alert, not authorization. Offline administrators can review the persisted queue on return. Pending applicants cannot access messages, channels, or workspace socket rooms.

Replacing an invite code prevents new submissions with the old code; pending requests still require review. A rejected request remains rejected when the code is resubmitted. Terminal decisions are retained for 30 days and pruned on new submissions; the audit log retains review events. The embedded request queue is capped at 1,000 entries to bound document growth. For larger organizations, migrate both membership and requests to separate collections with transactional admission and paginate the review UI.

Workspace owners/admins can edit details and rotate invite codes. Only the owner or global administrator can delete a workspace, with exact-name confirmation. Global administrators retain restore controls. `WORKSPACE_CREATION=members` allows account holders to create their own teams; `admin` restricts creation to the server administrator. `ALLOWED_REGISTRATION_DOMAIN` can optionally restrict registration. Legacy `AUTO_JOIN_DEFAULT_WORKSPACE=true` can bootstrap/repair the configured default workspace for its owner and existing members, but no longer enrolls people based on their email domain. All new memberships require approval.


## Verification

Run `npm --prefix backend run test:auth`, `npm --prefix backend run test:admin`, `npm --prefix backend run test:regression-isolated`, and `npm --prefix backend run test:workspace-approval` from the project root. The browser suite starts isolated API/web services and a disposable local MongoDB database. It verifies approval/rejection, persisted applicant status, admin notifications, blocked HTTP and socket access while pending, and messaging after approval.

This change is limited to backend and web. The mobile client retains its previous join behavior and must be updated separately before using this approval API.
