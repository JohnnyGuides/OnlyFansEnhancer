using OFEnhancer.Protocol;
using System.Text;
using OFEnhancer.Desktop;
namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class GoogleSubredditPresetsTests
{
    [TestMethod]
    public void ExactSourceAndHeadersYieldPresetsWithConservativeUnknownStatus()
    {
        byte[] body=Encoding.UTF8.GetBytes("""{"range":"'2026 Video Catalogue'!Z1:AB501","values":[["Subreddit","Status","Notes"],["r/example","Approved","Read rules"],["review_me","Unconfirmed","Check"]]}""");
        var result=GoogleSubredditPresets.Parse(body,"2026 Video Catalogue",501);
        Assert.AreEqual(2,result.Rows.Count);
        Assert.AreEqual("example",result.Rows[0].Subreddit);
        Assert.AreEqual("Approved",result.Rows[0].Status);
        Assert.AreEqual("Needs review",result.Rows[1].Status);
        Assert.ThrowsException<GoogleCatalogueException>(()=>GoogleSubredditPresets.Parse(body,"Different tab",501));
    }

    [DataTestMethod]
    [DataRow("[[\"Other\",\"Status\",\"Notes\"]]")]
    [DataRow("[[\"Subreddit\",\"Status\",\"Notes\"],[\"example\",\"Approved\"],[\"EXAMPLE\",\"Rejected\"]]")]
    [DataRow("[[\"Subreddit\",\"Status\",\"Notes\"],[\"https://evil.example\",\"Approved\"]]")]
    public void InvalidHeadersDuplicateNamesAndInvalidSubredditsAreRejected(string values)
    {
        byte[] body=Encoding.UTF8.GetBytes("{\"range\":\"'Catalogue'!Z1:AB501\",\"values\":"+values+"}");
        Assert.ThrowsException<GoogleCatalogueException>(()=>GoogleSubredditPresets.Parse(body,"Catalogue",501));
    }
}
