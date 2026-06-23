package dev.cribbage.zero;

/**
 * JNI bridge to the native Cribbage Zero engine (libczactor.so). Step 1 exposes only a self-play smoke
 * bench that proves the C++ core runs under the NDK; later steps add the bus/GitHub actor entry points
 * (and the JNI->Java HttpURLConnection callbacks the native side uses for HTTP).
 */
public final class NativeBridge {
    static { System.loadLibrary("czactor"); }

    private NativeBridge() {}

    /** Run {pairs} antithetic self-play pairs at {sims} MCTS sims on {workers} threads; returns a status line. */
    public static native String selfPlayBench(int pairs, int sims, int workers);
}
