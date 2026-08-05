import { redirect } from 'next/navigation';

/** Today is the landing page. The app shell layout gates on authentication. */
export default function RootPage() {
  redirect('/today');
}
