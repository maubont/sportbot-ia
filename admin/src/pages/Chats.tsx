import { Navigate } from "react-router-dom";

/** Legacy entry point; operator conversations now live in the audited Inbox. */
export default function Chats() {
    return <Navigate to="/inbox" replace />;
}
