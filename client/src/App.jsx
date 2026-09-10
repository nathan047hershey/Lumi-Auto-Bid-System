import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { FullscreenLoader } from './components/Loader';
import Login from './pages/Login';
import PasswordReset from './pages/PasswordReset';
import AdminDashboard from './pages/admin/Dashboard';
import UserManagement from './pages/admin/UserManagement';
import CandidateProfiles from './pages/admin/CandidateProfiles';
import ProfileForm from './pages/admin/ProfileForm';
import Assignments from './pages/admin/Assignments';
import AdminApplications from './pages/admin/Applications';
import AdminInterviewRequests from './pages/admin/InterviewRequests';
import AdminSettings from './pages/admin/Settings';
import AdminResumeTemplates from './pages/admin/ResumeTemplates';
import Developers from './pages/admin/Developers';
import AdminJobLinks from './pages/admin/JobLinks';
import JobLinkDetail from './pages/JobLinkDetail';
import UserDashboard from './pages/user/Dashboard';
import UserStatsDashboard from './pages/user/UserStatsDashboard';
import ProfileView from './pages/user/ProfileView';
import ResumeGenerator from './pages/user/ResumeGenerator';
import ResumeTemplateBuilder from './pages/user/ResumeTemplateBuilder';
import Applications from './pages/user/Applications';
import InterviewRequests from './pages/user/InterviewRequests';
import AccountSettings from './pages/user/AccountSettings';
import AutofillSettingsPage from './pages/AutofillSettingsPage';
import BidInsights from './pages/user/BidInsights';
import Analyze from './pages/user/Analyze';
import BidCourses from './pages/user/BidCourses';
import CvQualityReport from './pages/user/CvQualityReport';
import Inbox from './pages/user/Inbox';
import CallerDashboard from './pages/caller/CallerDashboard';
import CallerProfile from './pages/caller/CallerProfile';
import ManagerDashboard from './pages/manager/Dashboard';
import ManagerProfileForm from './pages/manager/ProfileForm';
import ManagerUsers from './pages/manager/Users';
import DeveloperDashboard from './pages/developer/DeveloperDashboard';
import DeveloperProfile from './pages/developer/DeveloperProfile';
import Layout from './components/Layout';
import PipelineHub from './pages/PipelineHub';
import PerformanceHub from './pages/PerformanceHub';

function RedirectWithId({ toPrefix }) {
    const { id } = useParams();
    const location = useLocation();
    return <Navigate to={`${toPrefix}/${id}${location.search || ''}`} replace />;
}

function ProtectedRoute({ children, adminOnly = false, managerOnly = false, callerOnly = false }) {
    const { user, additionalRoles, loading } = useAuth();

    if (loading) {
        return <FullscreenLoader message="Loading your workspace..." />;
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    const hasAdminRole = user.role === 'admin' || additionalRoles.includes('admin');
    const hasManagerRole = user.role === 'manager' || additionalRoles.includes('manager');
    const hasCallerRole = user.role === 'caller' || additionalRoles.includes('caller');

    if (adminOnly && !hasAdminRole) {
        return <Navigate to="/user/settings" replace />;
    }

    if (managerOnly && !hasManagerRole && !hasAdminRole) {
        return <Navigate to="/user/settings" replace />;
    }

    if (callerOnly && !hasCallerRole && !hasAdminRole) {
        return <Navigate to="/user/settings" replace />;
    }

    return children;
}

function App() {
    const { user, additionalRoles, loading } = useAuth();

    if (loading) {
        return <FullscreenLoader message="Loading your workspace..." />;
    }

    return (
        <Routes>
            <Route path="/login" element={
                user ? <Navigate to={
                    user.role === 'admin' || additionalRoles.includes('admin') ? '/admin/settings' :
                    user.role === 'caller' || additionalRoles.includes('caller') ? '/caller/settings' :
                    user.role === 'manager' || additionalRoles.includes('manager') ? '/manager/settings' :
                    user.role === 'developer' || additionalRoles.includes('developer') ? '/developer/settings' :
                    '/user/settings'
                } replace /> : <Login />
            } />
            <Route path="/reset-password" element={<PasswordReset />} />

            {/* Admin Routes */}
            <Route path="/admin" element={
                <ProtectedRoute adminOnly>
                    <Layout />
                </ProtectedRoute>
            }>
                <Route index element={<Navigate to="settings" replace />} />
                <Route path="dashboard" element={<AdminDashboard />} />
                <Route path="users" element={<UserManagement />} />
                <Route path="developers" element={<Developers />} />
                <Route path="profiles" element={<CandidateProfiles />} />
                <Route path="profiles/new" element={<ProfileForm />} />
                <Route path="profiles/:id/edit" element={<ProfileForm />} />
                <Route path="autofill-settings" element={<AutofillSettingsPage />} />
                <Route path="assignments" element={<Assignments />} />
                <Route path="settings" element={<AdminSettings />} />
                <Route path="resume-templates" element={<AdminResumeTemplates />} />

                <Route path="pipeline" element={<PipelineHub />}>
                    <Route index element={<AdminJobLinks embedded />} />
                    <Route path="applications" element={<AdminApplications embedded />} />
                    <Route path="interviews" element={<AdminInterviewRequests embedded />} />
                    <Route path="links/:id" element={<JobLinkDetail />} />
                </Route>
                <Route path="performance" element={<PerformanceHub />}>
                    <Route index element={<BidCourses embedded />} />
                    <Route path="courses/:id" element={<BidCourses embedded />} />
                    <Route path="analyze" element={<Analyze embedded />} />
                </Route>

                {/* Legacy redirects — preserve bookmarks */}
                <Route path="applications" element={<Navigate to="/admin/pipeline/applications" replace />} />
                <Route path="interviews" element={<Navigate to="/admin/pipeline/interviews" replace />} />
                <Route path="job-links" element={<Navigate to="/admin/pipeline" replace />} />
                <Route path="job-links/:id" element={<RedirectWithId toPrefix="/admin/pipeline/links" />} />
                <Route path="bid-courses" element={<Navigate to="/admin/performance" replace />} />
                <Route path="bid-courses/:id" element={<RedirectWithId toPrefix="/admin/performance/courses" />} />
                <Route path="analyze" element={<Navigate to="/admin/performance/analyze" replace />} />
            </Route>

            {/* User Routes */}
            <Route path="/user" element={
                <ProtectedRoute>
                    <Layout />
                </ProtectedRoute>
            }>
                <Route index element={<Navigate to="settings" replace />} />
                <Route path="profiles" element={<UserDashboard />} />
                <Route path="dashboard" element={<UserStatsDashboard />} />

                <Route path="pipeline" element={<PipelineHub />}>
                    <Route index element={<AdminJobLinks embedded />} />
                    <Route path="applications" element={<Applications embedded />} />
                    <Route path="interviews" element={<InterviewRequests embedded />} />
                    <Route path="links/:id" element={<JobLinkDetail />} />
                </Route>
                <Route path="performance" element={<PerformanceHub />}>
                    <Route index element={<BidCourses embedded />} />
                    <Route path="courses/:id" element={<BidCourses embedded />} />
                    <Route path="insights" element={<BidInsights embedded />} />
                    <Route path="analyze" element={<Analyze embedded />} />
                </Route>

                {/* Legacy redirects */}
                <Route path="applications" element={<Navigate to="/user/pipeline/applications" replace />} />
                <Route path="job-links" element={<Navigate to="/user/pipeline" replace />} />
                <Route path="job-links/:id" element={<RedirectWithId toPrefix="/user/pipeline/links" />} />
                <Route path="interviews" element={<Navigate to="/user/pipeline/interviews" replace />} />
                <Route path="bid-insights" element={<Navigate to="/user/performance/insights" replace />} />
                <Route path="analyze" element={<Navigate to="/user/performance/analyze" replace />} />
                <Route path="bid-courses" element={<Navigate to="/user/performance" replace />} />
                <Route path="bid-courses/:id" element={<RedirectWithId toPrefix="/user/performance/courses" />} />

                <Route path="profile/:id" element={<ProfileView />} />
                <Route path="generate" element={<ResumeGenerator />} />
                <Route path="generate/:profileId" element={<ResumeGenerator />} />
                <Route path="cv-quality" element={<CvQualityReport />} />
                <Route path="cv-quality/:applicationId" element={<CvQualityReport />} />
                <Route path="templates" element={<ResumeTemplateBuilder />} />
                <Route path="templates/:templateId" element={<ResumeTemplateBuilder />} />
                <Route path="autofill-settings" element={<AutofillSettingsPage />} />
                <Route path="settings" element={<AccountSettings />} />
                <Route path="inbox" element={<Inbox />} />
            </Route>

            {/* Caller Routes */}
            <Route path="/caller" element={
                <ProtectedRoute>
                    <Layout />
                </ProtectedRoute>
            }>
                <Route index element={<Navigate to="settings" replace />} />
                <Route path="dashboard" element={<CallerDashboard />} />
                <Route path="profile" element={<CallerProfile />} />
                <Route path="settings" element={<AccountSettings />} />
            </Route>

            {/* Manager Routes */}
            <Route path="/manager" element={
                <ProtectedRoute managerOnly>
                    <Layout />
                </ProtectedRoute>
            }>
                <Route index element={<Navigate to="settings" replace />} />
                <Route path="dashboard" element={<ManagerDashboard />} />
                <Route path="profiles/new" element={<ManagerProfileForm />} />
                <Route path="profiles/:id/edit" element={<ManagerProfileForm />} />
                <Route path="autofill-settings" element={<AutofillSettingsPage />} />
                <Route path="users" element={<ManagerUsers />} />
                <Route path="settings" element={<AccountSettings />} />
            </Route>

            {/* Developer Routes */}
            <Route path="/developer" element={
                <ProtectedRoute>
                    <Layout />
                </ProtectedRoute>
            }>
                <Route index element={<Navigate to="settings" replace />} />
                <Route path="dashboard" element={<DeveloperDashboard />} />
                <Route path="profile" element={<DeveloperProfile />} />
                <Route path="settings" element={<AccountSettings />} />
            </Route>

            {/* Default redirect */}
            <Route path="*" element={
                <Navigate to={
                    user ? (
                        user.role === 'admin' || additionalRoles.includes('admin') ? '/admin/settings' :
                        user.role === 'caller' || additionalRoles.includes('caller') ? '/caller/settings' :
                        user.role === 'manager' || additionalRoles.includes('manager') ? '/manager/settings' :
                        user.role === 'developer' || additionalRoles.includes('developer') ? '/developer/settings' :
                        '/user/settings'
                    ) : '/login'
                } replace />
            } />
        </Routes>
    );
}

export default App;
