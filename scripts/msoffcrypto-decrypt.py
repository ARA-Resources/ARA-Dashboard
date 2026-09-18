"""
MS-OFFCRYPTO helper for validate-excel.ts.

Two modes, always communicating back to Node as one line of JSON on stdout:

  inspect <input-path>
    Reports whether the file is a password-encrypted OOXML file. Detection is
    via the internal CFB directory (EncryptedPackage / EncryptionInfo
    streams), not just the outer OLE2 signature -- a plain legacy .xls file
    has the same outer signature but none of these streams.
    -> {"ok": true, "encrypted": bool}
    -> {"ok": false, "error": "..."}   (unreadable / not a CFB file at all)

  decrypt <input-path> <output-path>
    Reads the password from the ARA_EXCEL_DECRYPT_PASSWORD env var (never a
    CLI arg, so it never appears in `ps`). Decrypts input-path into
    output-path as a plain OOXML (.xlsx) file.
    -> {"ok": true}
    -> {"ok": false, "errorCode": "WRONG_PASSWORD", "error": "..."}
    -> {"ok": false, "errorCode": "NO_PASSWORD", "error": "..."}
    -> {"ok": false, "error": "..."}   (any other decrypt failure)
"""

import json
import os
import sys


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def inspect(input_path):
    import olefile

    if not olefile.isOleFile(input_path):
        # Not a CFB/OLE2 container at all -- can't be MS-OFFCRYPTO encrypted.
        emit({"ok": True, "encrypted": False})

    ole = olefile.OleFileIO(input_path)
    try:
        encrypted = ole.exists("EncryptedPackage") and ole.exists("EncryptionInfo")
    finally:
        ole.close()
    emit({"ok": True, "encrypted": bool(encrypted)})


def decrypt(input_path, output_path):
    import msoffcrypto
    from msoffcrypto.exceptions import InvalidKeyError

    password = os.environ.get("ARA_EXCEL_DECRYPT_PASSWORD")
    if not password:
        emit({
            "ok": False,
            "errorCode": "NO_PASSWORD",
            "error": "No decryption password was provided to the decrypt helper.",
        })

    with open(input_path, "rb") as f:
        office_file = msoffcrypto.OfficeFile(f)
        try:
            office_file.load_key(password=password, verify_password=True)
        except InvalidKeyError:
            emit({
                "ok": False,
                "errorCode": "WRONG_PASSWORD",
                "error": "The configured password did not decrypt this file.",
            })

        with open(output_path, "wb") as out:
            office_file.decrypt(out)

    emit({"ok": True})


def main():
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "Usage: msoffcrypto-decrypt.py <inspect|decrypt> <input-path> [output-path]"})

    mode = sys.argv[1]
    input_path = sys.argv[2]

    try:
        if mode == "inspect":
            inspect(input_path)
        elif mode == "decrypt":
            if len(sys.argv) < 4:
                emit({"ok": False, "error": "decrypt mode requires an output-path argument."})
            decrypt(input_path, sys.argv[3])
        else:
            emit({"ok": False, "error": f"Unknown mode: {mode}"})
    except Exception as exc:  # noqa: BLE001 -- always report back as JSON, never a raw traceback
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
