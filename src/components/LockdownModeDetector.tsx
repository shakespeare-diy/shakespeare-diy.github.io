import { useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Detects if IndexedDB is unavailable (which happens in iOS lockdown mode)
 * and displays a blocking alert dialog informing the user.
 */
export function LockdownModeDetector() {
  const [isLockdownMode, setIsLockdownMode] = useState(false);

  useEffect(() => {
    // Check if IndexedDB is available
    const checkIndexedDB = async () => {
      try {
        // Check if IndexedDB exists
        if (!window.indexedDB) {
          setIsLockdownMode(true);
          return;
        }

        // Try to open a test database to verify IndexedDB actually works
        // In iOS lockdown mode, indexedDB exists but throws errors when used
        const testDBName = '_shakespeare_lockdown_test';
        const request = window.indexedDB.open(testDBName, 1);

        request.onerror = () => {
          setIsLockdownMode(true);
        };

        request.onsuccess = () => {
          // IndexedDB is working, clean up test database
          request.result.close();
          window.indexedDB.deleteDatabase(testDBName);
        };
      } catch {
        // Any error means IndexedDB is not available
        setIsLockdownMode(true);
      }
    };

    checkIndexedDB();
  }, []);

  return (
    <AlertDialog open={isLockdownMode}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-left">🔒 Lockdown Mode Detected</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 text-left">
            <p>
              Shakespeare requires IndexedDB to function, which is unavailable in iOS Lockdown Mode.
            </p>
            <p>
              To use Shakespeare, please disable Lockdown Mode in your device settings:
            </p>
            <ol className="list-decimal list-inside space-y-1 text-left ml-4">
              <li>Open Settings</li>
              <li>Go to Privacy &amp; Security</li>
              <li>Tap Lockdown Mode</li>
              <li>Turn off Lockdown Mode</li>
            </ol>
          </AlertDialogDescription>
        </AlertDialogHeader>
      </AlertDialogContent>
    </AlertDialog>
  );
}
