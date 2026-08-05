'use client';

import { LogOut } from 'lucide-react';
import { signOutAction } from '@/app/actions/session';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm" aria-label="Sign out">
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </form>
  );
}
