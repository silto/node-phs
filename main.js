var google = require ('googleapis');
var fs = require('fs');
var api_key_file;
try {
    api_key_file = fs.readFileSync('yt_api_key.txt','utf8');
} catch (e) {
    if (e.code === 'ENOENT') {
        console.error('File not found!');
    } else {
        throw e;
    }
}

var key_regexp = /[A-Za-z0-9\-]{30,}/;
var api_key = key_regexp.exec(api_key_file);
if (api_key === null) {
    console.error("google API key not found");
    process.exit(1);
}else{
    api_key = api_key[0];
    console.log("google API key : "+api_key);
}

google.options ({ auth: api_key });
var youtube = google.youtube ('v3');

var channel_ids = fs.readFileSync('yt_ids.txt').toString().split("\n");
while (channel_ids[channel_ids.length - 1] === "" || channel_ids[channel_ids.length - 1] == " ") {
    channel_ids.pop();
}
console.log(channel_ids.length+" channels loaded");

//variables de temporisation
var MAX_DAILY = 50000000;
var MAX_100S = 300000;
var MAX_20S  = Math.min(MAX_100S/100, MAX_DAILY/(24*3600))*20;
var quota_20s = 0;
var quota_total = 0;
var start_time = 0;
var last_20s_check = 0;
var quota_update = function(increm){
    quota_20s+=increm;
    quota_total+=increm;
};
var quota_check = function(){
    var now = Date.now();
    var exec_time = (now-start_time)/1000;
    if (exec_time == 0) {
        return true;
    }
    if ((now-last_20s_check)/1000 > 20) {
        console.log("testing 20s quota");
        last_20s_check = now;
        var tmpQuota = quota_20s;
        quota_20s = 0;
        if (tmpQuota > MAX_20S) {
            return false;
        }
    }
    if (quota_total/exec_time*20 > MAX_20S) {
        return false;
    }
    return true;
};

// Search Youtube -- callback is called on each found item
function search_youtube (query, callback) {

    var queryObject = {
        part: 'snippet',
        type: 'video',
        maxResults: 4,
        order: 'viewCount',
        safeSearch: 'none'
    };
    if (query.q !== undefined) {
        queryObject.q = query.q;
    }
  if (query.pageToken !== undefined) {
      queryObject.pageToken = query.pageToken;
  }
  if (query.maxResults !==undefined) {
      queryObject.maxResults = query.maxResults;
  }if (query.channel !== undefined) {
      queryObject.channelId = query.channel;
  }
  var videos = [];
  var detailsLoop = function(res, index, errors, outfunction){
      //console.log(res);
      if (index >= res.length) {
          if (errors === '') {
              outfunction(null, videos);
          }else{
              outfunction(errors, videos);
          }

      }else{
          var video = {
            id: res[index].id.videoId,
            title: res[index].snippet.title || '',
            channelTitle: res[index].snippet.channelTitle,
            channelId: res[index].snippet.channelId
          };
          console.log("Qt: "+quota_total+" fetching details for video "+ index + "("+video.title+")");

          if (quota_check() === false) {
              setTimeout(function(){console.log("temporisation");detailsLoop(res,index,errors,outfunction);},1000);
          }else{
              quota_update(1+2+2);
              youtube.videos.list (
                {
                  part: 'statistics, contentDetails',
                  id: video.id
                },
                function (err2, data) {
                  if (err2) { detailsLoop(res, index+1, errors+"\n"+err2, outfunction); }
                  if (data.items.length >= 1) {
                    data.items[0].contentDetails.duration.replace (/PT(\d+)M(\d+)S/, function (t, m, s) {
                      video.duration = (parseInt (m) *60) + parseInt (s);
                    });
                    video.definition = data.items[0].contentDetails.definition;
                      video.views = parseInt(data.items[0].statistics.viewCount);
                      video.likes = parseInt(data.items[0].statistics.likeCount);
                      video.dislikes = parseInt(data.items[0].statistics.dislikeCount);
                      video.comments = parseInt(data.items[0].statistics.commentCount);
                    videos.push(video);

                    detailsLoop(res, index+1, errors, outfunction);
                  }
                }
              );
          }

      }

  };
  if (quota_check() === false) {
      setTimeout(function(){console.log("temporisation");search_youtube(query, callback);},1000);
  }else{
      quota_update(100);
      youtube.search.list (
        queryObject,
        function (err, res) {
          if (err) { return callback (err); }


          detailsLoop(res.items, 0,'', callback);

        //   res.items.forEach (function (result) {
        //     var video = {
        //       id: result.id.videoId,
        //       //urlShort: 'http://youtu.be/'+ result.id.videoId,
        //       //urlLong: 'http://www.youtube.com/watch?v='+ result.id.videoId,
        //       //published: result.snippet.publishedAt,
        //       title: result.snippet.title || '',
        //       //description: result.snippet.description || '',
        //       //images: result.snippet.thumbnails,
        //       channelTitle: result.snippet.channelTitle,
        //       //channelId: result.snippet.channelId,
        //       //live: result.snippet.liveBroadcastContent || ''
        //     };
          //
        //     youtube.videos.list (
        //       {
        //         part: 'statistics, contentDetails',
        //         id: video.id
        //       },
        //       function (err2, data) {
        //         if (err2) { return callback (err2); }
        //         if (data.items.length >= 1) {
        //           data.items[0].contentDetails.duration.replace (/PT(\d+)M(\d+)S/, function (t, m, s) {
        //             video.duration = (parseInt (m) *60) + parseInt (s);
        //           });
        //           video.definition = data.items[0].contentDetails.definition;
        //             video.views = data.items[0].statistics.viewCount;
        //             video.likes = data.items[0].statistics.likeCount;
        //             video.dislikes = data.items[0].statistics.dislikeCount;
        //             video.comments = data.items[0].statistics.commentCount;
        //           videos.push(video);
        //         }
        //       }
        //     );
        //   });
        //   callback(videos.length)

        }
      );
  }
}

var like_view_analyzer = function(err, videos){
    if (err !== null) {
        console.error(err);
        return;
    }
    var stats = {
        min_ratio : 10000,
        max_ratio : 0,
        avg_ratio : null
    };
    var dataPoints = [];
    var cumulViews = 0;
    var cumulLikes = 0;
    fs.appendFileSync('logstats.txt',"\nchannelName , views , likes , ratio , duration , comments", 'utf8');
    for (var i = 0; i < videos.length; i++) {
        var ratio = videos[i].likes/videos[i].views;
        if (ratio < stats.min_ratio) {
            stats.min_ratio = ratio;
        }
        if (ratio> stats.max_ratio) {
            stats.max_ratio = ratio;
        }
        cumulLikes+=videos[i].likes;
        cumulViews+=videos[i].views;
        console.log(ratio + "\n" + "views : " + videos[i].views);
        var statsPoint = {
            channelName:videos[i].channelTitle,
            views: videos[i].views,
            likes: videos[i].likes,
            ratio: ratio,
            duration : videos[i].duration,
            comments: videos[i].comments
        };
        dataPoints.push(statsPoint);
        fs.appendFileSync('logstats.txt',"\n"+
        statsPoint.channelName+" , "+
        statsPoint.views+" , "+
        statsPoint.likes+" , "+
        statsPoint.ratio+" , "+
        statsPoint.duration+" , "+
        statsPoint.comments,
         'utf8');
    }
    stats.avg_ratio = cumulLikes/cumulViews;

    console.log(stats);
};

//search sequence
start_time = Date.now();
search_youtube({channel:'UCXIYLgIp6DYZHjmUUUXErmg', maxResults: 50},like_view_analyzer);
