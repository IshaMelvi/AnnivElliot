param([ValidateSet('List', 'Restore')][string]$Action = 'List', [string]$WindowId = '0')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CherubWindow {
  public string id;
  public string name;
  public bool minimized;
}
public static class CherubWindows {
  private delegate bool EnumProc(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, uint attribute, out int value, int size);
  public static CherubWindow[] List() {
    var windows = new List<CherubWindow>();
    EnumWindows((handle, data) => {
      if (!IsWindowVisible(handle)) return true;
      int style = GetWindowLong(handle, -20);
      if ((style & 0x80) != 0 || (GetWindow(handle, 4) != IntPtr.Zero && (style & 0x40000) == 0)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var title = new StringBuilder(1024);
      if (GetWindowText(handle, title, title.Capacity) == 0) return true;
      windows.Add(new CherubWindow { id = "window:" + handle.ToInt64() + ":0", name = title.ToString(), minimized = IsIconic(handle) });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static void Restore(long id) { ShowWindowAsync(new IntPtr(id), 9); }
}
'@
if ($Action -eq 'Restore') {
  if ($WindowId -notmatch '^\d{1,16}$') { throw 'Invalid window handle' }
  $match = @([CherubWindows]::List() | Where-Object { $_.id -eq "window:${WindowId}:0" })
  if ($match.Count -ne 1) { throw 'Window is no longer available' }
  if ($match[0].minimized) { [CherubWindows]::Restore([long]$WindowId) }
  'true'
} else {
  ConvertTo-Json -InputObject @([CherubWindows]::List()) -Compress
}
