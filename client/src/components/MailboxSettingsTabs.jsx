/**
 * MailboxSettingsTabs
 * Wraps OutlookMailSettings (Microsoft Graph, personal) and
 * GmailMailSettings (Google Gmail via IMAP App Password) under one
 * tabbed card so admins can connect either or both.
 */
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import OutlookMailSettings from './OutlookMailSettings';
import GmailMailSettings from './GmailMailSettings';

export default function MailboxSettingsTabs({ className = '', profiles = [], profileId = null }) {
    return (
        <Tabs defaultValue="outlook" className="w-full">
            <TabsList className="mb-3 grid w-full grid-cols-2">
                <TabsTrigger value="outlook" className="text-xs sm:text-sm">
                    Microsoft Outlook
                </TabsTrigger>
                <TabsTrigger value="gmail" className="text-xs sm:text-sm">
                    Google Gmail
                </TabsTrigger>
            </TabsList>
            <TabsContent value="outlook" forceMount className="data-[state=inactive]:hidden">
                <OutlookMailSettings
                    className={className}
                    profiles={profiles}
                    profileId={profileId}
                />
            </TabsContent>
            <TabsContent value="gmail" forceMount className="data-[state=inactive]:hidden">
                <GmailMailSettings className={className} />
            </TabsContent>
        </Tabs>
    );
}
