/* Direct Windows 7 RAW spooler helper. No CRT, CLR, PowerShell or Zig runtime.
 * Build both architectures with scripts/build-win7-native.mjs (Zig 0.13.0).
 * Success means Windows accepted the job, not that paper physically printed.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <winspool.h>
#include <shellapi.h>

/* Zig's COFF linker retains this index even in a freestanding C executable.
 * The helper does not use TLS or require CRT TLS initialization. */
DWORD _tls_index = 0;

static void text(HANDLE stream, const char *value) {
  DWORD length = 0, written;
  while (value[length]) ++length;
  WriteFile(stream, value, length, &written, NULL);
}

static void number(HANDLE stream, DWORD value) {
  char buffer[16];
  int index = 15;
  buffer[index] = 0;
  do { buffer[--index] = (char)('0' + value % 10); value /= 10; } while (value);
  text(stream, buffer + index);
}

static int failure(const char *stage, DWORD code) {
  HANDLE stream = GetStdHandle(STD_ERROR_HANDLE);
  LPWSTR message = NULL;
  text(stream, stage);
  text(stream, " failed (");
  number(stream, code);
  text(stream, ")");
  if (FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
      FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0, (LPWSTR)&message, 0, NULL)) {
    int size = WideCharToMultiByte(CP_UTF8, 0, message, -1, NULL, 0, NULL, NULL);
    char *utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size);
    if (utf8) {
      WideCharToMultiByte(CP_UTF8, 0, message, -1, utf8, size, NULL, NULL);
      text(stream, ": ");
      text(stream, utf8);
      HeapFree(GetProcessHeap(), 0, utf8);
    }
    LocalFree(message);
  }
  text(stream, "\r\n");
  return 1;
}

static BOOL file_port(LPCWSTR port) {
  if (!port) return FALSE;
  if (lstrcmpiW(port, L"FILE:") == 0 || lstrcmpiW(port, L"PORTPROMPT:") == 0) return TRUE;
  return ((port[0] >= L'A' && port[0] <= L'Z') || (port[0] >= L'a' && port[0] <= L'z')) &&
    port[1] == L':' && (port[2] == L'\\' || port[2] == L'/');
}

static int send_job(LPWSTR printer_name, LPCWSTR filename) {
  HANDLE heap = GetProcessHeap(), printer = NULL;
  HANDLE file = INVALID_HANDLE_VALUE;
  BYTE *buffer = NULL, *info_buffer = NULL;
  DOC_INFO_1W document;
  DWORD error = 0, needed = 0, read = 0, written = 0;
  const char *stage = "CreateFile";
  BOOL started = FALSE;
  int result = 1;

  file = CreateFileW(filename, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (file == INVALID_HANDLE_VALUE) { error = GetLastError(); goto cleanup; }
  buffer = (BYTE *)HeapAlloc(heap, 0, 65536);
  if (!buffer) { stage = "Allocate print buffer"; error = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }

  stage = "OpenPrinter";
  if (!OpenPrinterW(printer_name, &printer, NULL)) { error = GetLastError(); goto cleanup; }

  /* Keep the existing file-port guard without PowerShell's Get-Printer cmdlet. */
  GetPrinterW(printer, 2, NULL, 0, &needed);
  if (needed) {
    info_buffer = (BYTE *)HeapAlloc(heap, 0, needed);
    if (info_buffer && GetPrinterW(printer, 2, info_buffer, needed, &needed) &&
        file_port(((PRINTER_INFO_2W *)info_buffer)->pPortName)) {
      text(GetStdHandle(STD_ERROR_HANDLE), "Printer is set to save to a file instead of printing. Select the printer's real USB or network port in Windows Printer properties > Ports.\r\n");
      goto cleanup;
    }
  }

  document.pDocName = L"Kliovo Print Agent";
  document.pOutputFile = NULL;
  document.pDatatype = L"RAW";
  stage = "StartDocPrinter";
  if (StartDocPrinterW(printer, 1, (BYTE *)&document) == 0) { error = GetLastError(); goto cleanup; }
  started = TRUE;
  stage = "StartPagePrinter";
  if (!StartPagePrinter(printer)) { error = GetLastError(); goto cleanup; }

  for (;;) {
    DWORD offset = 0;
    stage = "ReadFile";
    if (!ReadFile(file, buffer, 65536, &read, NULL)) { error = GetLastError(); goto cleanup; }
    if (read == 0) break;
    while (offset < read) {
      stage = "WritePrinter";
      if (!WritePrinter(printer, buffer + offset, read - offset, &written)) { error = GetLastError(); goto cleanup; }
      if (written == 0 || written > read - offset) { error = ERROR_WRITE_FAULT; goto cleanup; }
      offset += written;
    }
  }
  stage = "EndPagePrinter";
  if (!EndPagePrinter(printer)) { error = GetLastError(); goto cleanup; }
  stage = "EndDocPrinter";
  if (!EndDocPrinter(printer)) { error = GetLastError(); goto cleanup; }
  started = FALSE;
  result = 0;

cleanup:
  if (started) AbortPrinter(printer);
  if (printer) ClosePrinter(printer);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (info_buffer) HeapFree(heap, 0, info_buffer);
  if (buffer) HeapFree(heap, 0, buffer);
  if (error) result = failure(stage, error);
  return result;
}

void mainCRTStartup(void) {
  int argc = 0, result = 1;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) ExitProcess((UINT)failure("Parse command line", GetLastError()));
  if (argc == 2 && lstrcmpW(argv[1], L"--self-test") == 0) {
#ifdef _WIN64
    text(GetStdHandle(STD_OUTPUT_HANDLE), "KLIOVO_RAWPRINT_READY:1:x64\r\n");
#else
    text(GetStdHandle(STD_OUTPUT_HANDLE), "KLIOVO_RAWPRINT_READY:1:ia32\r\n");
#endif
    result = 0;
  } else if (argc == 3) {
    result = send_job(argv[1], argv[2]);
  } else {
    text(GetStdHandle(STD_ERROR_HANDLE), "Usage: kliovo-rawprint.exe <printer name> <job file>\r\n");
  }
  LocalFree(argv);
  ExitProcess((UINT)result);
}
