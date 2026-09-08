import { Outlet } from 'react-router-dom';

/**
 * Route group wrapper — primary/sub navigation lives in Layout.
 */
export default function HubShell() {
    return <Outlet />;
}
