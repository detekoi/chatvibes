# src/components/music/musicService.py
import replicate
import sys
import json
import os

replicate_client = replicate.Client(api_token=os.environ["REPLICATE_API_TOKEN"])

def generate_music(prompt, negative_prompt=None, seed=None):
    try:
        input_data = {"prompt": prompt}
        if negative_prompt:
            input_data["negative_prompt"] = negative_prompt
        if seed:
            input_data["seed"] = seed
            
        output = replicate_client.run(
            "google/lyria-2",
            input=input_data
        )
        
        return {
            "success": True,
            "audio_url": output,
            "prompt": prompt
        }
    except Exception as e:
        error_msg = str(e)
        if "Prompt was rejected" in error_msg and "artist names" in error_msg:
            return {
                "success": False,
                "error": "artist_names_rejected",
                "message": "Prompt was rejected. Do not include artist names in the prompt."
            }
        return {
            "success": False,
            "error": "generation_failed",
            "message": f"Music generation failed: {error_msg}"
        }

if __name__ == "__main__":
    try:
        input_data = json.loads(sys.argv[1])
        result = generate_music(**input_data)
        print(json.dumps(result))
    except Exception as e:
        error_result = {
            "success": False,
            "error": "service_error",
            "message": str(e)
        }
        print(json.dumps(error_result))