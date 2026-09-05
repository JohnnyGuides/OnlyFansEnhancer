using OFEnhancer.Desktop;

namespace OFEnhancer.Protocol.Tests;

[TestClass]
public sealed class RestartManagerMessageTests
{
    [TestMethod]
    public void Update_query_is_accepted_without_closing_early()
    {
        RestartManagerDecision decision = RestartManagerMessage.Decide(
            RestartManagerMessage.QueryEndSession,
            nint.Zero,
            RestartManagerMessage.CloseApplication
        );

        Assert.IsTrue(decision.Handled);
        Assert.AreEqual(new nint(1), decision.Result);
        Assert.IsFalse(decision.Shutdown);
    }

    [TestMethod]
    public void Confirmed_update_end_requests_a_graceful_shutdown()
    {
        RestartManagerDecision decision = RestartManagerMessage.Decide(
            RestartManagerMessage.EndSession,
            new nint(1),
            RestartManagerMessage.CloseApplication
        );

        Assert.IsTrue(decision.Handled);
        Assert.AreEqual(nint.Zero, decision.Result);
        Assert.IsTrue(decision.Shutdown);
    }

    [TestMethod]
    public void Cancelled_or_unrelated_session_messages_stay_with_WPF()
    {
        Assert.AreEqual(
            default,
            RestartManagerMessage.Decide(
                RestartManagerMessage.EndSession,
                nint.Zero,
                RestartManagerMessage.CloseApplication
            )
        );
        Assert.AreEqual(
            default,
            RestartManagerMessage.Decide(0x0010, nint.Zero, RestartManagerMessage.CloseApplication)
        );
        Assert.AreEqual(
            default,
            RestartManagerMessage.Decide(
                RestartManagerMessage.QueryEndSession,
                nint.Zero,
                unchecked((nint)0x80000000)
            )
        );
    }
}
