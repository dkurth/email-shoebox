; Windows uninstaller: ask before deleting the imported mail (No is the default).
; An update runs the old uninstaller silently; it must never delete mail, so this runs only on a real uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent shoebox_keep_mail
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your imported mail?$\r$\n$\r$\nThis deletes the collections in $APPDATA\Email Shoebox\collections. Collections that you stored in other folders stay." IDNO shoebox_keep_mail
    RMDir /r "$APPDATA\Email Shoebox\collections"
    Delete "$APPDATA\Email Shoebox\collections.json"
    shoebox_keep_mail:
  ${endIf}
!macroend
