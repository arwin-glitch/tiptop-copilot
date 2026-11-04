import { TabLoading } from '@/components/shell/tab-loading';
import { INBOX_SHELL } from '@/lib/email/inbox-folders';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';

/** Shown the moment the tab is clicked: the header, then placeholder shapes. */
export default function InboxLoading() {
  return <TabLoading header={PAGE_HEADERS.inbox} body="inbox" className={INBOX_SHELL} />;
}
