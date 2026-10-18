import {
  BookOpen,
  Briefcase,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Download,
  Inbox,
  Landmark,
  ListChecks,
  MailCheck,
  MessageCircleMore,
  Newspaper,
  Settings,
  Sun,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The icon of each help entry: the same one the navigation shows for the page
 * (components/shell/nav.tsx), and the launcher's for Ask Arwin. A plain map
 * rather than a read of NAV_ITEMS, which lives in a client module and so
 * cannot be read from the server-rendered help page.
 */
export const HELP_ICONS: Record<string, LucideIcon> = {
  today: Sun,
  'follow-ups': MailCheck,
  tasks: CheckSquare,
  deals: Target,
  inbox: Inbox,
  calendar: CalendarClock,
  lists: ListChecks,
  portfolio: Briefcase,
  'fund-ii': Landmark,
  meetings: CalendarDays,
  network: Users,
  reports: Newspaper,
  knowledge: BookOpen,
  settings: Settings,
  download: Download,
  ask: MessageCircleMore,
};
