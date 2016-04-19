"use strict";

var google = require ('googleapis');
var fs = require('fs');
//var readline = require('readline');
var readlineSync = require('readline-sync');

const readline = require('readline');



var depthpipe = 4;
var outpipe = "logstats.txt";
var titleLine = "\nchannelId , channelName , views , likes , ratio , duration , comments , age";


var re_depth = /--depth=(\d+)/i;
var re_out = /--output=([A-Za-z0-9_\.\-]+)/i;

var youtube_api_key = null;
var youtube = null;

var channel_ids = ['UCXIYLgIp6DYZHjmUUUXErmg'];

var dataPoints = [];

//variables de temporisation
const MAX_DAILY = 50000000;
const MAX_100S = 300000;
const MAX_20S  = Math.min(MAX_100S/100, MAX_DAILY/(24*3600))*20;
var quota_20s = 0;
var quota_total = 0;
var start_time = 0;
var last_20s_check = 0;

//read arguments
process.argv.forEach(function(val) {
    var depthParam = val.match(re_depth);
    if(depthParam !== null){
        //console.log("type of param depth : "+ (typeof depthParam[1]));
        depthpipe = depthParam[1];
    }
    var outParam = val.match(re_out);
    if(outParam !== null){
        //console.log("type of param out : "+ (typeof outParam[1]));
        outpipe = outParam[1];


    }
    else if (val == "--help") {
        console.log("Proper Usage: node main.js");
        console.log("    --depth=n           Sets max depth of exploration per channel");
        console.log("    --output=filename   use file 'filename' for output");
        console.log("    --help              Help menu");
        console.log("");
        process.exit(0);
    }
});


var openFiles = function(){

    var criticalError = function(err){
        console.error("ERR : " + err);
        process.exit(1);
    };

    var outOpenProm = function(resolve, reject){
        fs.stat(outpipe,(err, stats) => {
            if(err){
                if(err.code == 'ENOENT') {
                    console.log("output file doesn't exists, will be created");
                } else {
                    console.log("output file doesn't exists or something else happened : ", err.code);
                }
                fs.writeFile(outpipe,titleLine,"utf8", (err) => {
                    if (err) {
                        reject("could not write title line to file.");
                    }else{
                        resolve();
                    }
                });
            }else{
                console.log("output file exists");

                let rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                rl.question('Do you want to overwrite(o)?append(a)? ', (answer) => {
                    if (answer == "o") {
                        fs.writeFile(outpipe,titleLine,"utf8", (err) => {
                            if (err) {
                                reject("could not write title line to file.");
                            }else{
                                resolve();
                            }
                        });
                    }else{
                        resolve();
                    }
                rl.close();
                });
            }
        });
    };

    var apiKeyOpenProm = function(resolve, reject){
        fs.readFile('yt_api_key.txt','utf8', (err,api_key_file) => {
            if(err){
                if (err.code === 'ENOENT') {
                    reject('Key file not found!');
                }else{
                    reject("unknown error opening api key file.");
                }

            }else{
                let key_regexp = /[A-Za-z0-9\-]{30,}/;
                let api_key = key_regexp.exec(api_key_file);
                if (api_key === null) {
                    reject("google API key not found in provided file");
                }else{
                    resolve(api_key[0]);
                    
                }
            }
        });
    };

    var openChannelListProm = function(resolve, reject){
        fs.readFile('yt_ids.txt',"utf8",(err, data) => {
            if (err) {
                reject(err);
            }else{
                let channels = data.split("\n");
                while (channels[channels.length - 1] === "" || channels[channels.length - 1] == " ") {
                    channels.pop();
                }
                console.log(channels.length+" channels loaded");
                channel_ids = channels;
                resolve();
            }
        });
    }

    var outOpen = new Promise(outOpenProm)
    .then(() => {
        console.log("Success opening output file.");

        var apiKeyOpen = new Promise(apiKeyOpenProm)
        .then((api_key) => {
            youtube_api_key = api_key;
            console.log("Success opening API key file.");

            var channelListOpen = new Promise(openChannelListProm)
            .then(API_init)
            .catch((err) => { 
                console.error("non-critical error reading channel list :\n"+err);
                API_init();
            });
        })
        .catch(criticalError);

    })
    .catch(criticalError);

};

var API_init = function(){
    google.options ({ auth: youtube_api_key });
    youtube = google.youtube ('v3');
    console.log("API initialised");

    //start searching
    start_time = Date.now();
    chainSearch({depth: depthpipe, channelIds: channel_ids, postAction:like_view_analyzer});

};



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
        console.log("quota 20s : "+tmpQuota+"/"+MAX_20S);
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
        order: 'date',
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
                channelId: res[index].snippet.channelId,
                timeSincePublished: Math.floor((Date.now() - Date.parse(res[index].snippet.publishedAt))/1000)
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
                        data.items[0].contentDetails.duration.replace (/PT(\d+)M(\d+)S/, 
                            function (t, m, s) {
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
        setTimeout(function(){
            console.log("temporisation");
            search_youtube(query, callback);
        },1000);
    }else{
        quota_update(100);
        youtube.search.list (
            queryObject,
            function (err, res) {
                if (err) { return callback (err); }
  
                detailsLoop(res.items, 0,'', callback);
  
            }
        );
    }
}

var like_view_analyzer = function(err, videos, callback){
    if (err !== null) {
        console.error(err);
        return;
    }
    var stats = {
        min_ratio : 10000,
        max_ratio : 0,
        avg_ratio : null
    };
    console.log("like/view analyzer start");
    var cumulViews = 0;
    var cumulLikes = 0;
    //fs.appendFileSync(outpipe,"\nchannelName , views , likes , ratio , duration , comments , age", 'utf8');
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
        //console.log(ratio + "\n" + "views : " + videos[i].views);
        var statsPoint = {
            channelId:videos[i].channelId,
            channelName:videos[i].channelTitle,
            views: videos[i].views,
            likes: videos[i].likes,
            ratio: ratio,
            duration : videos[i].duration,
            comments: videos[i].comments,
            age: videos[i].timeSincePublished
        };
        dataPoints.push(statsPoint);
        fs.appendFileSync(outpipe,"\n"+
        statsPoint.channelId+" , "+
        statsPoint.channelName+" , "+
        statsPoint.views+" , "+
        statsPoint.likes+" , "+
        statsPoint.ratio+" , "+
        statsPoint.duration+" , "+
        statsPoint.comments+" , "+
        statsPoint.age,
         'utf8');
    }
    stats.avg_ratio = cumulLikes/cumulViews;

    console.log(stats);
    callback();
};

//search sequence
// start_time = Date.now();
//search_youtube({channel:'UCXIYLgIp6DYZHjmUUUXErmg', maxResults: 50},like_view_analyzer);

var defaultPost = function(err, videos, callback){
    if (err) {
        console.error(err);
    }
    if (videos) {
        console.log("loaded "+videos.length+" videos.");
    }
    callback();
};
var chainSearch = function(params){
    var options = {};
    options.depth = params.depth || 4;
    options.channelIds = params.channelIds || ['UCXIYLgIp6DYZHjmUUUXErmg'];
    options.postAction = params.postAction || defaultPost;
    var calendar = [];


    var scheduler = function(index){
        if (index == -1) {//init calendar
            console.log("initialising scheduling jobs...");
            for (var i = 0; i < options.channelIds.length; i++) {
                console.log("defining schedule for channel "+options.channelIds[i]);

                calendar.push((j) => {
                    console.log("executing Task "+j+" on channel " + options.channelIds[j]);
                    search_youtube(
                        {channel:options.channelIds[j], 
                        maxResults: options.depth}, 
                        (err, videos) => {
                        options.postAction(err, videos, () => {
                            scheduler(j+1);
                        });
                    });
                });

            }
            console.log("... Done.");
            scheduler(0);
        }else if(index < calendar.length){

            calendar[index](index);
        }else if (index >= calendar.length) {
            console.log("No job left. Exiting scheduler.");
        }
    };

    scheduler(-1);
};

openFiles();
