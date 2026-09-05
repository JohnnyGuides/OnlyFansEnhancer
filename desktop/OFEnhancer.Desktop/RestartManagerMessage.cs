namespace OFEnhancer.Desktop;

internal readonly record struct RestartManagerDecision(bool Handled, nint Result, bool Shutdown);

internal static class RestartManagerMessage
{
    internal const int QueryEndSession = 0x0011;
    internal const int EndSession = 0x0016;
    internal const int CloseApplication = 0x00000001;

    internal static RestartManagerDecision Decide(int message, nint wParam, nint lParam)
    {
        if ((lParam.ToInt64() & CloseApplication) == 0)
            return default;
        if (message == QueryEndSession)
            return new(true, new nint(1), false);
        if (message == EndSession && wParam != nint.Zero)
            return new(true, nint.Zero, true);
        return default;
    }
}
