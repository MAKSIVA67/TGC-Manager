package com.tcgmanager.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  // The app's whole layout is hand-tuned in fixed px against a 480px-wide
  // column -- without this, the WebView applies the phone's system font-size
  // setting on top of that (Android's WebView inherits OS-level text scaling
  // by default, even for fixed-px CSS), which is why the title wrapped to 3
  // lines and the profile name/team inputs overflowed on a real device even
  // though it rendered correctly in every desktop-Chrome test.
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getBridge().getWebView().getSettings().setTextZoom(100);
  }
}
